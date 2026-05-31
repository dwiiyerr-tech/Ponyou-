/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata yang tidak tersedia on-chain:
 *  - Kapan posisi dideploy
 *  - Sinyal/lesson yang aktif saat entry
 *  - Peak PnL untuk trailing logic
 *  - Catatan close + instruksi manual
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { atomicWriteJsonAsync } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.PONYOU_STATE_FILE || path.join(__dirname, "state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

export function buildPositionKey(position, wallet_address = null) {
  return wallet_address ? `${position}::${wallet_address}` : position;
}

function parsePositionKey(positionKey = "") {
  const [position, wallet_address] = String(positionKey).split("::");
  return { position, wallet_address: wallet_address || null };
}

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

let _stateCache = null;
let _writeQueue = Promise.resolve();

function load() {
  if (_stateCache) return _stateCache;
  if (!fs.existsSync(STATE_FILE)) {
    _stateCache = { positions: {}, recentEvents: [], lastUpdated: null };
    return _stateCache;
  }
  try {
    _stateCache = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return _stateCache;
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
}

export function getState() {
  return load();
}

export function cleanStaleTestPositions() {
  const state = getState();
  const positions = state.positions || {};
  let cleaned = 0;
  for (const key of Object.keys(positions)) {
    // Test position markers use fake mints like "mintSell::walletB".
    // Keep valid multi-wallet keys: "<valid_mint>::<wallet>".
    const pos = positions[key];
    const mint = pos?.mint || key.split("::")[0] || "";
    const isSmokeTest = key === "SMOKE_TEST_POS" || mint === "SMOKE_TEST_POS";
    const isInvalidMint = mint.length < 32 || mint.length > 44;
    const isTestMultiWalletKey = key.includes("::") && isInvalidMint;
    if (isSmokeTest || isTestMultiWalletKey || (!key.includes("::") && isInvalidMint)) {
      delete positions[key];
      cleaned++;
    }
  }
  // Also clean stale test events from recentEvents
  let eventsCleaned = 0;
  const events = state.recentEvents || [];
  if (events.length > 0) {
    const testMintPattern = /^(mintSell|SMOKE_TEST|TEST_)/i;
    state.recentEvents = events.filter(e => {
      const isTest = testMintPattern.test(e.position || "") || testMintPattern.test(e.position_key || "");
      if (isTest) eventsCleaned++;
      return !isTest;
    });
  }
  if (cleaned > 0 || eventsCleaned > 0) {
    save({ ...state, positions, recentEvents: state.recentEvents });
    log("state", `Cleaned ${cleaned} stale/test positions + ${eventsCleaned} events from state`);
  }
  return cleaned;
}

let _lastWriteFailed = false;

async function save(state) {
  // Queue writes so concurrent trackPosition/recordClose calls don't race.
  // Returns a promise that resolves when the write completes. Callers can
  // check _lastWriteFailed immediately after await to detect durability loss.
  _writeQueue = _writeQueue.then(async () => {
    state.lastUpdated = new Date().toISOString();
    try {
      await atomicWriteJsonAsync(STATE_FILE, state);
      _stateCache = state;
      _lastWriteFailed = false;
    } catch (err) {
      log("state_error", `Failed to write state.json: ${err.message}`);
      _lastWriteFailed = true;
    }
  }).catch(() => {}); // keep queue alive even if a prev write failed
  return _writeQueue;
}

export function wasLastWriteFailed() {
  return _lastWriteFailed;
}

/**
 * Drain the in-flight write queue. Call before process.exit() so pending
 * state.json writes are not abandoned mid-flush. Errors are already logged
 * inside save(); we swallow here to keep shutdown best-effort.
 */
export async function flushState() {
  try {
    await _writeQueue;
  } catch (_) {
    // errors already logged in save()
  }
}

/**
 * Replace the in-memory state with a new object and persist it.
 * Prefer this over direct atomicWriteJson to state.json — it serialises
 * through the write queue and avoids races with concurrent trackPosition()
 * or recordClose() calls.
 */
export function saveState(state) {
  _stateCache = state;
  return save(state);
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position. Returns the save() promise so callers
 * that need durability (BUY confirmations, deploy callbacks) can await
 * the disk write; older callers that don't await still work, but a crash
 * between mutation and flush would lose the position registration.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  amount_sol,
  initial_value_usd,
  signal_snapshot = null,
  active_lessons = [],
  active_signals = [],
  wallet_address = null,
  cast_net_group_id = null,
  cast_net_slot = null,
  strategy_used = null,
}) {
  const state = load();
  const position_key = buildPositionKey(position, wallet_address);

  // ST-6: previously, when initial_value_usd was unset/zero, we fell back to
  // amount_sol — but amount_sol is in SOL (e.g. 0.5), not USD (e.g. $100).
  // Downstream PnL math (currentUSD - initial_value_usd) / initial_value_usd
  // would then compare USD against SOL and report ~200x inflated/deflated
  // gains. Now we keep initial_value_usd at 0 and mark the position
  // pnl_unknown:true so PnL consumers can short-circuit instead of
  // producing misleading numbers.
  const usd = Number(initial_value_usd);
  const usdValid = Number.isFinite(usd) && usd > 0;
  if (!usdValid) {
    log("state_warn",
      `trackPosition: initial_value_usd=${initial_value_usd} for ${position_key} — PnL marked unknown; consumers must skip PnL calc`,
    );
  }

  state.positions[position_key] = {
    position_key,
    position,
    pool,
    pool_name,
    amount_sol,
    initial_value_usd: usdValid ? usd : 0,
    pnl_unknown: !usdValid,
    signal_snapshot: signal_snapshot || {
      mint: position,
      recorded_at: new Date().toISOString(),
      _fallback: true,
    },
    active_lessons: active_lessons || [],
    active_signals: active_signals || [],
    wallet_address,
    deployed_at: new Date().toISOString(),
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    sync_misses: 0,
    // G2: cast-net group tagging. Positions opened via the same cast-net
    // fire share a group_id so management can coordinate staggered exits.
    cast_net_group_id: cast_net_group_id || null,
    cast_net_slot: cast_net_slot != null ? Number(cast_net_slot) : null,
    // G3: per-coin strategy selection — the strategy actually used to open
    // this position. Management reads this so exit params follow the same
    // strategy preset the entry used, not the globally-active strategy.
    strategy_used: strategy_used || null,
  };
  pushEvent(state, { action: "deploy", position, position_key, pool_name: pool_name || pool, wallet_address });
  const saved = save(state);
  log("state", `Tracked new position: ${position_key} in pool ${pool}`);
  return saved;
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
function findPositionKeys(state, position, wallet_address = null, openOnly = false) {
  const matches = [];
  for (const [key, pos] of Object.entries(state.positions || {})) {
    if (pos.position !== position && key !== position) continue;
    if (wallet_address && pos.wallet_address !== wallet_address) continue;
    if (openOnly && pos.closed) continue;
    matches.push(key);
  }
  return matches;
}

export function listTrackedPositions(position = null, { wallet_address = null, open_only = false } = {}) {
  const state = load();
  const all = Object.values(state.positions || {});
  return all.filter(pos => {
    if (position && pos.position !== position && pos.position_key !== position) return false;
    if (wallet_address && pos.wallet_address !== wallet_address) return false;
    if (open_only && pos.closed) return false;
    return true;
  });
}

export function recordClose(position_address, reason, wallet_address = null) {
  const state = load();
  const keys = state.positions[position_address]
    ? [position_address]
    : findPositionKeys(state, position_address, wallet_address, true);
  if (keys.length === 0) return null;
  for (const key of keys) {
    const pos = state.positions[key];
    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
    pushEvent(state, { action: "close", position: pos.position, position_key: key, pool_name: pos.pool_name || pos.pool, reason, wallet_address: pos.wallet_address });
    log("state", `Position ${key} marked closed: ${reason}`);
  }
  return save(state);
}

/**
 * Mark a position as having had its partial-TP executed.
 * Prevents duplicate partial sells on subsequent management cycles.
 */
export function markPartialTPDone(position_address, wallet_address = null) {
  const state = load();
  const key = state.positions[position_address]
    ? position_address
    : findPositionKeys(state, position_address, wallet_address, true)[0];
  const pos = key ? state.positions[key] : null;
  if (!pos) return false;
  pos.partial_tp_done = true;
  pos.partial_tp_done_at = new Date().toISOString();
  const saved = save(state);
  log("state", `Position ${key} partial-TP marked done`);
  // Returning the promise lets callers await durability; the truthy value
  // also preserves the prior boolean-style contract for fire-and-forget callers.
  return saved;
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address] || findPositionKeys(state, position_address, null, false).map(k => state.positions[k])[0];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${pos.position_key || position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address, wallet_address = null) {
  const state = load();
  if (state.positions[position_address]) return state.positions[position_address] || null;
  const matches = findPositionKeys(state, position_address, wallet_address, true);
  if (matches.length === 1) return state.positions[matches[0]] || null;
  return matches.length > 0 ? state.positions[matches[0]] || null : null;
}

/**
 * Persist a new peak PnL for a position. Used by trailing-stop logic in the
 * management cycle, which needs the peak to survive restarts — otherwise the
 * trailing stop resets to 0 every restart and a position that pumped 50% then
 * dropped would slip past the trailing trigger.
 *
 * Returns the save promise so callers can await durability if they care.
 */
export function updatePeakPnl(position_address, peak_pnl_pct, wallet_address = null) {
  const state = load();
  const key = state.positions[position_address]
    ? position_address
    : findPositionKeys(state, position_address, wallet_address, true)[0];
  const pos = key ? state.positions[key] : null;
  if (!pos) return null;
  if (!(peak_pnl_pct > (pos.peak_pnl_pct || 0))) return null;
  pos.peak_pnl_pct = peak_pnl_pct;
  return save(state);
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    positions: open.map((p) => ({
      position: p.position,
      position_key: p.position_key || buildPositionKey(p.position, p.wallet_address),
      pool: p.pool,
      pool_name: p.pool_name,
      amount_sol: p.amount_sol,
      initial_value_usd: p.initial_value_usd,
      deployed_at: p.deployed_at,
      peak_pnl_pct: p.peak_pnl_pct,
      instruction: p.instruction || null,
      wallet_address: p.wallet_address || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago
// ST-4: require N consecutive on-chain misses before auto-closing. A single
// transient RPC sync hiccup used to be enough to mark a legitimate open
// position as closed; the counter resets the moment the position shows
// up on-chain again.
const SYNC_MISS_THRESHOLD = 3;

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    const normalizedKey = pos.position_key || buildPositionKey(pos.position, pos.wallet_address);
    const legacyMatch = activeSet.has(pos.position);
    if (pos.closed) continue;
    if (activeSet.has(posId) || activeSet.has(normalizedKey) || legacyMatch) {
      // Position visible on-chain again — reset the miss counter.
      if (pos.sync_misses && pos.sync_misses > 0) {
        pos.sync_misses = 0;
        changed = true;
      }
      continue;
    }

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    // ST-4: bump the miss counter; only auto-close after threshold.
    pos.sync_misses = (pos.sync_misses || 0) + 1;
    if (pos.sync_misses < SYNC_MISS_THRESHOLD) {
      log("state",
        `Position ${normalizedKey} missing from on-chain (miss ${pos.sync_misses}/${SYNC_MISS_THRESHOLD}) — not auto-closing yet`,
      );
      changed = true;
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (${SYNC_MISS_THRESHOLD} consecutive misses on-chain)`);
    changed = true;
    log("state", `Position ${normalizedKey} auto-closed (missing on-chain for ${SYNC_MISS_THRESHOLD} consecutive syncs)`);
  }

  if (changed) save(state); // fire-and-forget — the write queue persists, no need to block
}

export function _resetStateForTests() {
  _stateCache = null;
  _writeQueue = Promise.resolve();
}
