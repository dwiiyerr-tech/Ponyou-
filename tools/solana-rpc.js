/**
 * Solana RPC helpers used by the agent runtime.
 */

import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

// ─── Global raw-RPC rate limiter + circuit breaker ──────────────────────────
//
// The raw Solana JSON-RPC endpoint (RPC_URL, typically Helius) had NO throttle,
// unlike the helius.xyz/v0 enrichment path in rug-signals.js. getTokenSecurityDetails
// alone fires ~5 RPC/mint and the management cycle fans that out across a whole
// batch in parallel → bursts that trip Helius free-tier 429s. This mirrors the v0
// limiter: at most RPC_MAX_CONCURRENT in flight, slots spaced RPC_MIN_INTERVAL_MS
// apart, plus a circuit breaker that sheds load after a 429 storm. Tunable via env
// so the live operator can loosen/tighten without a code change.
//
// Only the discovery/enrichment paths (getSharedConnection consumers) route through
// this; the trade/swap path keeps its own connections so backpressure here can never
// stall an execution.

const RPC_MAX_CONCURRENT  = Math.max(1, Number(process.env.RPC_MAX_CONCURRENT)  || 3);
const RPC_MIN_INTERVAL_MS = Math.max(0, Number(process.env.RPC_MIN_INTERVAL_MS) || 120); // ~8 req/s ceiling
const RPC_CB_THRESHOLD    = Math.max(1, Number(process.env.RPC_CB_THRESHOLD)    || 5);    // consecutive 429s
const RPC_CB_COOLDOWN_MS  = Math.max(1000, Number(process.env.RPC_CB_COOLDOWN_MS) || 60_000);

let _rpcInflight    = 0;
const _rpcQueue     = [];
let _rpcNextSlot    = 0;
let _rpc429Streak   = 0;
let _rpcCBOpenUntil = 0;           // epoch ms; 0 = circuit closed

export function rpcCircuitOpen() {
  return Date.now() < _rpcCBOpenUntil;
}

function _rpc429Hit() {
  _rpc429Streak++;
  if (_rpc429Streak >= RPC_CB_THRESHOLD && !rpcCircuitOpen()) {
    _rpcCBOpenUntil = Date.now() + RPC_CB_COOLDOWN_MS;
    log("rpc_cb", `Raw RPC circuit OPEN — ${_rpc429Streak} consecutive 429s. Pausing raw RPC for ${Math.round(RPC_CB_COOLDOWN_MS / 1000)}s.`);
  }
}

function _rpcSuccess() {
  if (_rpc429Streak > 0) _rpc429Streak = 0;
  if (rpcCircuitOpen()) {
    _rpcCBOpenUntil = 0;
    log("rpc_cb", "Raw RPC circuit CLOSED — endpoint responding normally.");
  }
}

async function _rpcAcquire() {
  if (rpcCircuitOpen()) throw new Error("raw RPC circuit open");

  // Wait for an in-flight slot.
  while (_rpcInflight >= RPC_MAX_CONCURRENT) {
    await new Promise(resolve => _rpcQueue.push(resolve));
  }
  _rpcInflight++;

  // Claim a unique time-slot synchronously before any await, so concurrent
  // acquirers serialise instead of thundering-herding the endpoint.
  const now = Date.now();
  const slot = Math.max(now, _rpcNextSlot);
  _rpcNextSlot = slot + RPC_MIN_INTERVAL_MS;
  if (slot > now) {
    await new Promise(r => setTimeout(r, slot - now));
  }

  // Re-check: the circuit may have opened while we waited for our slot.
  if (rpcCircuitOpen()) {
    _rpcReleaseSlot();
    throw new Error("raw RPC circuit open");
  }
}

function _rpcReleaseSlot() {
  _rpcInflight--;
  const next = _rpcQueue.shift();
  if (next) next();
}

function _is429(err) {
  const m = String(err?.message || err || "");
  return err?.statusCode === 429 || err?.code === 429 || /\b429\b|too many requests|rate.?limit/i.test(m);
}

// RPC methods that make a network round-trip and should be throttled. Sync
// helpers and websocket subscription methods (onAccountChange, etc. — which
// return a subscription id synchronously) are deliberately excluded: wrapping
// them in an async limiter would change their contract and break callers.
const THROTTLED_RPC_METHODS = new Set([
  "getAccountInfo", "getParsedAccountInfo",
  "getMultipleAccountsInfo", "getMultipleParsedAccounts",
  "getTokenLargestAccounts", "getTokenSupply", "getTokenAccountBalance",
  "getTokenAccountsByOwner", "getParsedTokenAccountsByOwner",
  "getProgramAccounts", "getParsedProgramAccounts",
  "getBalance", "getRecentPrioritizationFees",
  "getSignaturesForAddress", "getTransaction",
  "getParsedTransaction", "getParsedTransactions",
  "getLatestBlockhash", "getSlot", "getBlockTime",
]);

function _throttleMethod(fn, target) {
  return async (...args) => {
    await _rpcAcquire();
    try {
      const out = await fn.apply(target, args);
      _rpcSuccess();
      return out;
    } catch (e) {
      if (_is429(e)) _rpc429Hit();
      throw e;
    } finally {
      _rpcReleaseSlot();
    }
  };
}

/**
 * Wrap a Connection so every networked RPC method routes through the global
 * limiter. Internal web3.js calls bypass it (we apply on the real connection,
 * not the proxy), so there is no double-counting.
 */
export function throttleConnection(conn) {
  const wrapped = new Map();
  return new Proxy(conn, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") return orig;
      if (!THROTTLED_RPC_METHODS.has(prop)) return orig.bind(target);
      if (!wrapped.has(prop)) wrapped.set(prop, _throttleMethod(orig, target));
      return wrapped.get(prop);
    },
  });
}

let _sharedConnection = null;
/**
 * Shared, rate-limited raw-RPC connection for the discovery/enrichment paths.
 * Endpoint precedence matches the previous local getSolanaConnection helpers
 * (RPC_URL → public mainnet) so wiring this in changes throttling only, not
 * which endpoint is hit.
 */
export function getSharedConnection() {
  if (!_sharedConnection) {
    const url = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
    _sharedConnection = throttleConnection(new Connection(url, "confirmed"));
  }
  return _sharedConnection;
}

// Test hooks.
export function __rpcLimiterStats() {
  return { inflight: _rpcInflight, queued: _rpcQueue.length, streak: _rpc429Streak, circuitOpen: rpcCircuitOpen() };
}
export function __resetRpcLimiter() {
  _rpcInflight = 0;
  _rpcQueue.length = 0;
  _rpcNextSlot = 0;
  _rpc429Streak = 0;
  _rpcCBOpenUntil = 0;
  _sharedConnection = null;
}

export function shouldSkipEntriesForGasFee(gasFee) {
  return gasFee?.level === "extreme";
}

export function applyFeeEntryGuard(candidates, gasFee) {
  return shouldSkipEntriesForGasFee(gasFee) ? [] : candidates;
}

export async function getSolanaGasFee() {
  try {
    const connection = new Connection(
      process.env.HELIUS_RPC_URL || process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed",
    );
    const fees = await connection.getRecentPrioritizationFees();
    if (!fees.length) return { avg: 0, median: 0, level: "low" };

    const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    let level = "low";
    if (median > 500000) level = "extreme";
    else if (median > 100000) level = "high";
    else if (median > 10000) level = "medium";

    return { avg, median, level, unit: "micro-lamports" };
  } catch (error) {
    log("gas_error", error.message);
    return { error: error.message, avg: 0, median: 0, level: "unknown" };
  }
}
