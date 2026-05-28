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

// Well-known program / sysvar addresses that must NEVER be treated as pool/mint
const KNOWN_NON_MINT_ACCOUNTS = new Set([
  "11111111111111111111111111111111",              // System Program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // Token 2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // Associated Token Account
  "ComputeBudget111111111111111111111111111111",   // Compute Budget
  "SysvarRent111111111111111111111111111111111",   // Sysvar Rent
  "SysvarC1ock11111111111111111111111111111111",   // Sysvar Clock
  "Sysvar1nstructions1111111111111111111111111",   // Sysvar Instructions
  "MetaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",   // Metaplex Metadata
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // Jupiter v6
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",   // Jupiter v4
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",   // Raydium Route
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",   // Raydium pAMM
  PUMP_FUN_PROGRAM,
  RAYDIUM_AMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
]);

function isLikelyMintOrPool(addr) {
  if (!addr || typeof addr !== "string") return false;
  if (addr.length < 32 || addr.length > 44) return false;
  if (KNOWN_NON_MINT_ACCOUNTS.has(addr)) return false;
  // Reject addresses that are mostly "1" or "0" (system-style padded addresses)
  if (/^1{20,}/.test(addr) || /^0{20,}/.test(addr)) return false;
  return true;
}

let _subscriptionIds = [];
let _isListening = false;
let _connection = null;
let _newPoolCallback = null;
let _poolCache = new Map();
// OCL-2: heartbeat tracking. Updated every time a log event arrives. If no
// events flow for HEARTBEAT_STUCK_MS, the WS subscription is likely dead
// even though _isListening still reads true. Operator can read this via
// getOnChainListenerStatus(); supervisor can restart based on it.
let _lastEventAt = 0;
let _restartAttempts = 0;
let _lastStartConfig = null;
let _heartbeatTimer = null;
let _extractFailCount = 0;
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_STUCK_MS = 10 * 60_000;     // 10 minutes of silence = stuck
const HEARTBEAT_AUTO_RESTART = process.env.ONCHAIN_AUTO_RESTART !== "false"; // default on
const MAX_AUTO_RESTARTS = 5;                // give up after 5 to avoid loops
const EXTRACT_CIRCUIT_THRESHOLD = 20;       // OCL-7: tighten warn cadence when RPC is hosed

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

  // Remember config so the heartbeat-driven auto-restart (OCL-2) can rebuild
  // the listener with the same args after a stuck-stream detection.
  _lastStartConfig = { rpcUrl, wssUrl, onNewPool, enabled };

  // Track the subs we successfully register inside this call. If any of the
  // three onLogs() calls throws, we clean up the previous ones rather than
  // leaking them (OCL-3).
  const localSubs = [];

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

    function subscribe(programId, programName) {
      const subId = _connection.onLogs(
        new PublicKey(programId),
        (logs, ctx) => {
          if (logs.err) return;
          _lastEventAt = Date.now();  // OCL-2: prove the stream is alive
          handleProgramLogs(logs, ctx, programName, programId);
        },
        "processed"
      );
      localSubs.push(subId);
      return subId;
    }

    subscribe(PUMP_FUN_PROGRAM,     "pumpfun");
    subscribe(RAYDIUM_AMM_PROGRAM,  "raydium_amm");
    subscribe(RAYDIUM_CPMM_PROGRAM, "raydium_cpmm");

    _subscriptionIds = localSubs;
    _isListening = true;
    _lastEventAt = Date.now();    // seed; treats "no event yet" as fresh
    _extractFailCount = 0;
    _startHeartbeat();
    log("onchain_listener", `Listening to 3 programs: pumpfun, raydium_amm, raydium_cpmm (ws=${wsEndpoint})`);
    return { ok: true, subscriptions: 3, endpoint: wsEndpoint };
  } catch (e) {
    // OCL-3: tear down any subs we registered before the failure so a half-
    // attached listener doesn't leak into the connection's subscription map.
    for (const subId of localSubs) {
      try { _connection?.removeOnLogsListener?.(subId).catch(() => {}); } catch (_) {}
    }
    _subscriptionIds = [];
    _connection = null;
    _isListening = false;
    log("onchain_listener_error", `Failed to start: ${e.message}`);
    return { ok: false, message: e.message };
  }
}

// OCL-2: heartbeat watchdog. If no events have arrived for HEARTBEAT_STUCK_MS,
// the underlying WS is almost certainly disconnected (web3.js doesn't surface
// this directly). We log a warn, and if ONCHAIN_AUTO_RESTART is on we tear
// down and re-subscribe.
function _startHeartbeat() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(() => {
    if (!_isListening) return;
    const idleMs = Date.now() - (_lastEventAt || Date.now());
    if (idleMs < HEARTBEAT_STUCK_MS) return;

    log("onchain_listener_warn",
      `No events for ${Math.round(idleMs / 60000)}min — WebSocket likely dead`,
    );

    if (!HEARTBEAT_AUTO_RESTART) return;
    if (_restartAttempts >= MAX_AUTO_RESTARTS) {
      log("onchain_listener_error",
        `Reached max auto-restart attempts (${MAX_AUTO_RESTARTS}) — giving up; operator intervention needed`,
      );
      return;
    }

    const saved = _lastStartConfig;
    _restartAttempts += 1;
    log("onchain_listener", `Auto-restart attempt ${_restartAttempts}/${MAX_AUTO_RESTARTS}`);
    stopOnChainListener();
    // Re-init with saved config; preserves the original callback.
    const r = startOnChainListener(saved);
    if (r.ok) log("onchain_listener", `Auto-restart succeeded`);
    else log("onchain_listener_error", `Auto-restart failed: ${r.message}`);
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive solely for this watchdog.
  _heartbeatTimer.unref?.();
}

// Rate-limit getParsedTransaction fetches — Solana RPC has tight limits on free tier.
// Override with ONCHAIN_FETCH_BUDGET_PER_MIN for paid tiers.
const FETCH_BUDGET_PER_MIN = Math.max(1, Number(process.env.ONCHAIN_FETCH_BUDGET_PER_MIN) || 30);
let _fetchBudget = { tokens: FETCH_BUDGET_PER_MIN, resetAt: Date.now() + 60_000 };
let _seenSignatures = new Map(); // signature -> ts (dedup so we don't fetch the same sig twice)

function takeFetchToken() {
  if (Date.now() > _fetchBudget.resetAt) {
    _fetchBudget = { tokens: FETCH_BUDGET_PER_MIN, resetAt: Date.now() + 60_000 };
  }
  if (_fetchBudget.tokens <= 0) return false;
  _fetchBudget.tokens -= 1;
  return true;
}

function isCreationLog(logs, programName) {
  if (!logs?.logs?.length) return false;
  for (const line of logs.logs) {
    if (typeof line !== "string") continue;
    if (programName === "pumpfun" && /Instruction:\s*Create\b/i.test(line)) return true;
    if ((programName === "raydium_amm" || programName === "raydium_cpmm")
        && /Instruction:\s*Initialize/i.test(line)) return true;
  }
  return false;
}

function pubkeyToString(x) {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x.toBase58 === "function") return x.toBase58();
  if (x.pubkey) return pubkeyToString(x.pubkey);
  return null;
}

async function extractFromTx(signature, programName, programId) {
  try {
    const tx = await _connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx?.transaction?.message) return null;

    const instructions = tx.transaction.message.instructions || [];
    const innerIxs = (tx.meta?.innerInstructions || []).flatMap(ii => ii.instructions || []);
    const allIxs = [...instructions, ...innerIxs];

    for (const ix of allIxs) {
      const pid = pubkeyToString(ix.programId);
      if (pid !== programId) continue;

      const accs = (ix.accounts || []).map(pubkeyToString).filter(Boolean);
      if (accs.length === 0) continue;

      if (programName === "pumpfun") {
        // pumpfun Create instruction: accounts[0] is the new mint
        const mint = accs[0];
        if (isLikelyMintOrPool(mint)) return { mint, pool: null };
      }
      if (programName === "raydium_amm") {
        // Raydium AMM v4 initialize2: account[4] = AMM (pool), [8] = base mint
        const pool = accs[4];
        const mint = accs[8];
        if (isLikelyMintOrPool(pool) || isLikelyMintOrPool(mint)) {
          return {
            pool: isLikelyMintOrPool(pool) ? pool : null,
            mint: isLikelyMintOrPool(mint) ? mint : null,
          };
        }
      }
      if (programName === "raydium_cpmm") {
        // CPMM initialize: pool typically at low index; pick first non-known account
        for (const a of accs) {
          if (isLikelyMintOrPool(a)) return { pool: a, mint: null };
        }
      }
    }
    return null;
  } catch (e) {
    // OCL-7: silence the log line after threshold so a degraded RPC doesn't
    // flood the journal. Counter resets on first success (see caller).
    _extractFailCount += 1;
    if (_extractFailCount <= EXTRACT_CIRCUIT_THRESHOLD) {
      log("onchain_listener_warn", `tx fetch ${signature?.slice(0, 8)} failed: ${e.message}`);
    } else if (_extractFailCount === EXTRACT_CIRCUIT_THRESHOLD + 1) {
      log("onchain_listener_warn",
        `>${EXTRACT_CIRCUIT_THRESHOLD} consecutive tx fetch failures — suppressing further warns until next success`,
      );
    }
    return null;
  }
}

function handleProgramLogs(logs, ctx, programName, programId) {
  // In web3.js onLogs, the signature lives on the logs object, not the context
  const signature = logs?.signature || ctx?.signature || null;
  const slot = ctx?.slot || 0;
  if (!signature || signature.length < 64) return;

  // Only act on log streams that explicitly indicate a pool/mint creation
  if (!isCreationLog(logs, programName)) return;

  // Dedup by signature to avoid double-fetching the same tx
  if (_seenSignatures.has(signature)) return;
  _seenSignatures.set(signature, Date.now());
  // OCL-5: always prune by time, not only when the size cap is breached.
  // Low-traffic days could otherwise leak entries forever.
  const cutoff = Date.now() - POOL_CACHE_TTL_MS;
  for (const [k, ts] of _seenSignatures) if (ts < cutoff) _seenSignatures.delete(k);
  // Belt-and-suspenders cap in case time-prune lags (clock jump etc.).
  if (_seenSignatures.size > 500) {
    const sorted = [..._seenSignatures.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, sorted.length - 500)) _seenSignatures.delete(k);
  }

  if (!takeFetchToken()) return; // budget exhausted this minute

  // Fetch parsed tx asynchronously (fire and forget; cache populates when done)
  extractFromTx(signature, programName, programId).then(result => {
    // OCL-7: a single success resets the failure suppression so future
    // warns flow again once RPC recovers.
    if (result) _extractFailCount = 0;
    if (!result || (!result.mint && !result.pool)) return;

    const key = result.pool || result.mint;
    if (_poolCache.has(key)) return;

    const entry = {
      mint: result.mint || null,
      poolAddress: result.pool || null,
      program: programId,
      programName,
      signature,
      slot,
      timestamp: new Date().toISOString(),
    };
    _poolCache.set(key, { ...entry, ts: Date.now() });
    evictStaleCache();

    log("onchain_listener", `${programName}: new pool detected — ${(entry.poolAddress || entry.mint || "").slice(0, 12)}`);

    if (_newPoolCallback) {
      try { _newPoolCallback(entry); }
      catch (e) {
        log("onchain_listener_warn", `Callback error: ${e.message}`);
      }
    }
  }).catch(() => { /* swallow — error already logged in extractFromTx */ });
}

export function stopOnChainListener() {
  if (!_isListening || !_connection) return;
  for (const subId of _subscriptionIds) {
    try { _connection.removeOnLogsListener(subId).catch(() => {}); } catch (_) {}
  }
  _subscriptionIds = [];
  _isListening = false;
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  try { _connection._ws?.close?.(); } catch (_) { /* best effort */ }
  _connection = null;
  log("onchain_listener", "Stopped");
}

export function getOnChainListenerStatus() {
  const idleMs = _lastEventAt ? Date.now() - _lastEventAt : null;
  return {
    listening: _isListening,
    subscriptions: _subscriptionIds.length,
    cachedPools: _poolCache.size,
    last_event_at: _lastEventAt ? new Date(_lastEventAt).toISOString() : null,
    idle_seconds: idleMs != null ? Math.floor(idleMs / 1000) : null,
    stuck: idleMs != null && idleMs > HEARTBEAT_STUCK_MS,
    restart_attempts: _restartAttempts,
    extract_fail_count: _extractFailCount,
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
