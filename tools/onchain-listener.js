/**
 * On-Chain Pool Listener — Real-time DEX pool discovery
 *
 * Subscribes to Solana program logs via WebSocket to detect new pools
 * the MOMENT they're created — no DexScreener delay.
 *
 * Supported programs:
 *   - pump.fun  (6EF8rvec...)  — memecoin launches
 *   - Raydium CPMM (CPMM...)   — AMM pool creation
 *   - Raydium AMM (675kPX...)   — standard pool creation
 *
 * This closes the 3-5 minute discovery gap between on-chain event
 * and DexScreener indexing.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";

const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxoQB5qah1";

const POOL_CACHE_MAX = 200;     // max cached pools in memory
const POOL_CACHE_TTL_MS = 600_000; // 10 minutes before eviction

let _subscriptionIds = [];
let _isListening = false;
let _connection = null;
let _newPoolCallback = null;
let _poolCache = new Map();

function evictStaleCache() {
  const now = Date.now();
  for (const [key, entry] of _poolCache.entries()) {
    if (now - entry.ts > POOL_CACHE_TTL_MS) _poolCache.delete(key);
  }
  if (_poolCache.size > POOL_CACHE_MAX) {
    const sorted = [..._poolCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [key] of sorted.slice(0, sorted.length - POOL_CACHE_MAX)) {
      _poolCache.delete(key);
    }
  }
}

/**
 * Callback receives: { mint, poolAddress, program, programName, signature, slot, timestamp }
 */
export function startOnChainListener({ rpcUrl, wssUrl, onNewPool, enabled = true } = {}) {
  if (_isListening) return { ok: true, message: "Already listening" };
  if (!enabled) return { ok: false, message: "Listener disabled by config" };

  try {
    const wsEndpoint = wssUrl || (rpcUrl || "").replace("https://", "wss://").replace("http://", "ws://");
    if (!wsEndpoint.startsWith("ws")) {
      return { ok: false, message: `Invalid WebSocket URL: ${wsEndpoint}` };
    }

    _connection = new Connection(rpcUrl || "https://api.mainnet-beta.solana.com", {
      wsEndpoint,
      commitment: "processed",
    });
    _newPoolCallback = onNewPool || null;

    // Subscribe to pump.fun program
    const pumpSubId = _connection.onLogs(
      new PublicKey(PUMP_FUN_PROGRAM),
      (logs, ctx) => {
        if (logs.err) return;
        handleProgramLogs(logs, ctx, "pumpfun", PUMP_FUN_PROGRAM);
      },
      "processed"
    );
    _subscriptionIds.push(pumpSubId);

    // Subscribe to Raydium AMM
    const raydiumSubId = _connection.onLogs(
      new PublicKey(RAYDIUM_AMM_PROGRAM),
      (logs, ctx) => {
        if (logs.err) return;
        handleProgramLogs(logs, ctx, "raydium_amm", RAYDIUM_AMM_PROGRAM);
      },
      "processed"
    );
    _subscriptionIds.push(raydiumSubId);

    // Subscribe to Raydium CPMM
    const cpmmSubId = _connection.onLogs(
      new PublicKey(RAYDIUM_CPMM_PROGRAM),
      (logs, ctx) => {
        if (logs.err) return;
        handleProgramLogs(logs, ctx, "raydium_cpmm", RAYDIUM_CPMM_PROGRAM);
      },
      "processed"
    );
    _subscriptionIds.push(cpmmSubId);

    _isListening = true;
    log("onchain_listener", `Listening to 3 programs: pumpfun, raydium_amm, raydium_cpmm (ws=${wsEndpoint})`);
    return { ok: true, subscriptions: 3, endpoint: wsEndpoint };
  } catch (e) {
    log("onchain_listener_error", `Failed to start: ${e.message}`);
    return { ok: false, message: e.message };
  }
}

function handleProgramLogs(logs, ctx, programName, programId) {
  const signature = ctx?.signature || "unknown";
  const slot = ctx?.slot || 0;

  // Extract pool address and mint from logs
  // pump.fun logs typically contain the mint address in the first inner instruction
  // Raydium logs contain pool address creation events
  const poolAddress = extractPoolAddress(logs, programName);
  const mintAddress = extractMintAddress(logs, programName);

  if (!poolAddress && !mintAddress) return;

  const key = poolAddress || mintAddress;
  if (_poolCache.has(key)) return; // dedup

  const entry = {
    mint: mintAddress || null,
    poolAddress: poolAddress || null,
    program: programId,
    programName,
    signature,
    slot,
    timestamp: new Date().toISOString(),
  };

  _poolCache.set(key, { ...entry, ts: Date.now() });
  evictStaleCache();

  log("onchain_listener", `${programName}: new pool detected — ${entry.poolAddress?.slice(0, 12) || entry.mint?.slice(0, 12)}`);

  if (_newPoolCallback) {
    try {
      _newPoolCallback(entry);
    } catch (e) {
      log("onchain_listener_warn", `Callback error: ${e.message}`);
    }
  }
}

function extractPoolAddress(logs, programName) {
  if (!logs?.logs?.length) return null;
  for (const logLine of logs.logs) {
    if (typeof logLine !== "string") continue;
    // Look for "Program log: initialize" or "Program log: createPool" patterns
    // and extract the pool address (base58, 32-44 chars) from nearby data
    if (/initializ|create.*pool|new.*pool/i.test(logLine)) {
      // The pool address is typically in the instruction data or preceding logs
      // For now, return the first base58-looking string near the create message
      const matches = logLine.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
      if (matches) return matches[0];
    }
  }
  // Fallback: the first 32+ char base58 string in logs
  for (const logLine of logs.logs) {
    if (typeof logLine !== "string") continue;
    const matches = logLine.match(/[1-9A-HJ-NP-Za-km-z]{40,44}/g);
    if (matches) return matches[0];
  }
  return null;
}

function extractMintAddress(logs, programName) {
  if (!logs?.logs?.length) return null;
  // pump.fun mint addresses often appear in "Program log: Mint:" or similar
  for (const logLine of logs.logs) {
    if (typeof logLine !== "string") continue;
    if (/mint|token/i.test(logLine)) {
      const matches = logLine.match(/[1-9A-HJ-NP-Za-km-z]{40,44}/g);
      if (matches) return matches[0];
    }
  }
  return null;
}

export function stopOnChainListener() {
  if (!_isListening || !_connection) return;
  for (const subId of _subscriptionIds) {
    _connection.removeOnLogsListener(subId).catch(() => {});
  }
  _subscriptionIds = [];
  _isListening = false;
  try { _connection._ws?.close?.(); } catch (_) { /* best effort */ }
  _connection = null;
  log("onchain_listener", "Stopped");
}

export function getOnChainListenerStatus() {
  return {
    listening: _isListening,
    subscriptions: _subscriptionIds.length,
    cachedPools: _poolCache.size,
    recentPools: [..._poolCache.values()]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 10)
      .map(e => ({ program: e.programName, pool: e.poolAddress?.slice(0, 12), mint: e.mint?.slice(0, 12), ts: e.timestamp })),
  };
}

/**
 * Get newly discovered pools from cache for injection into screening.
 * These are tokens that appeared on-chain but may not be indexed by DexScreener yet.
 */
export function getFreshOnChainCandidates({ maxAgeMs = 120_000, limit = 15 } = {}) {
  evictStaleCache();
  const now = Date.now();
  const candidates = [];
  for (const [, entry] of _poolCache.entries()) {
    if (now - entry.ts > maxAgeMs) continue;
    if (entry.mint) {
      candidates.push({
        mint: entry.mint,
        pool: entry.poolAddress,
        source: `onchain_${entry.programName}`,
        _hunter_score: entry.programName === "pumpfun" ? 35 : 40,
        _fresh_onchain: true,
        _discovered_at: entry.timestamp,
      });
    }
  }
  return candidates.slice(0, limit);
}
