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
import { log } from "./logger.js";

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

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

async function save(state) {
  _stateCache = state;
  _writeQueue = _writeQueue.then(async () => {
    try {
      state.lastUpdated = new Date().toISOString();
      await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      log("state_error", `Failed to write state.json: ${err.message}`);
    }
  });
  return _writeQueue;
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
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
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    amount_sol,
    initial_value_usd,
    signal_snapshot: signal_snapshot || null,
    active_lessons: active_lessons || [],
    active_signals: active_signals || [],
    deployed_at: new Date().toISOString(),
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
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
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
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
      pool: p.pool,
      pool_name: p.pool_name,
      amount_sol: p.amount_sol,
      initial_value_usd: p.initial_value_usd,
      deployed_at: p.deployed_at,
      peak_pnl_pct: p.peak_pnl_pct,
      instruction: p.instruction || null,
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

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
