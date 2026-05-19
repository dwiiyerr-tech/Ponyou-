/**
 * Kill switch — pauses all trading cycles when one of these conditions trips:
 *   - drawdown exceeds threshold from session start (default -20%)
 *   - consecutive swap errors exceed threshold (default 5)
 *   - manual trip via `kill-switch.flag` file or trip() call
 *
 * The flag file makes the kill state survive restarts. To resume, delete
 * the file (or call reset()).
 *
 * The actual gate is consulted in index.js `checkAllGates(cycleName)` so any
 * cron entrypoint short-circuits before doing work.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { recordCounter } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLAG_FILE = path.join(__dirname, "kill-switch.flag");
const STATE_FILE = new URL("./kill-switch-state.json", import.meta.url).pathname;

const DEFAULT_LIMITS = {
  drawdown_pct: -20,        // session drawdown trip-point
  consecutive_errors: 5,    // consecutive swap failures trip-point
};

// ─── In-memory state (rebuilt every restart; flag file is the source of truth) ───
let _sessionStartUsd = null;
let _consecutiveErrors = 0;

function _loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function _saveState(state = {}) {
  const payload = {
    sessionBaseline: Number.isFinite(state.sessionBaseline) ? state.sessionBaseline : null,
    tripAt: state.tripAt ?? null,
    consecutiveErrors: Number.isFinite(state.consecutiveErrors) ? state.consecutiveErrors : 0,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
}

function _currentTripAt() {
  const state = readKillState();
  return state?.tripped_at || state?.tripAt || null;
}

function _persistState(tripAt = _currentTripAt()) {
  try {
    _saveState({
      sessionBaseline: _sessionStartUsd,
      tripAt,
      consecutiveErrors: _consecutiveErrors,
    });
  } catch (e) {
    log("kill_switch_error", `Failed to write state: ${e.message}`);
  }
}

function _restoreState() {
  const saved = _loadState();
  if (!saved) return;

  if (Number.isFinite(saved.sessionBaseline) && saved.sessionBaseline > 0) {
    _sessionStartUsd = saved.sessionBaseline;
  }
  if (Number.isFinite(saved.consecutiveErrors) && saved.consecutiveErrors >= 0) {
    _consecutiveErrors = saved.consecutiveErrors;
  }
  if (saved.tripAt) {
    try {
      if (!fs.existsSync(FLAG_FILE)) {
        fs.writeFileSync(FLAG_FILE, JSON.stringify({
          tripped_at: saved.tripAt,
          reason: "restored",
          detail: "Restored from kill-switch state file",
        }, null, 2));
      }
    } catch (e) {
      log("kill_switch_error", `Failed to restore flag: ${e.message}`);
    }
  }
}

_restoreState();

/**
 * Snapshot session-start balance. Called once at startup.
 */
export function setSessionBaseline(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return;
  _sessionStartUsd = usd;
  _persistState();
}

/**
 * Update running session balance. Trips drawdown if exceeded.
 */
export function reportBalance(usd, limits = DEFAULT_LIMITS) {
  // Guard usd<=0 too — a 0 reading usually means the wallet RPC failed, and
  // computing it as a -100% drawdown would trip the kill switch on every
  // transient outage. The caller in index.js already filters this, but the
  // public function should be robust.
  if (!Number.isFinite(usd) || usd <= 0 || _sessionStartUsd == null || _sessionStartUsd <= 0) return false;
  const pct = ((usd - _sessionStartUsd) / _sessionStartUsd) * 100;
  if (pct <= limits.drawdown_pct) {
    trip({
      reason: "drawdown",
      detail: `Session P&L ${pct.toFixed(2)}% ≤ limit ${limits.drawdown_pct}%`,
    });
    return true;
  }
  return false;
}

/**
 * Record a swap outcome. Trips on N consecutive failures.
 */
export function recordSwapOutcome({ success }, limits = DEFAULT_LIMITS) {
  if (success) {
    _consecutiveErrors = 0;
    _persistState();
    return false;
  }
  _consecutiveErrors += 1;
  _persistState();
  if (_consecutiveErrors >= limits.consecutive_errors) {
    trip({
      reason: "consecutive_errors",
      detail: `${_consecutiveErrors} swaps failed in a row (limit ${limits.consecutive_errors})`,
    });
    return true;
  }
  return false;
}

/**
 * Manually or programmatically trip the kill switch. Persists to flag file so
 * a restart doesn't bypass it.
 */
export function trip({ reason = "manual", detail = "" } = {}) {
  const trippedAt = new Date().toISOString();
  const payload = {
    tripped_at: trippedAt,
    reason,
    detail,
  };
  try {
    fs.writeFileSync(FLAG_FILE, JSON.stringify(payload, null, 2));
    _persistState(trippedAt);
    log("kill_switch", `🛑 Kill switch tripped: ${reason} — ${detail}`);
    recordCounter("kill_switch_trip");
  } catch (e) {
    log("kill_switch_error", `Failed to write flag: ${e.message}`);
  }
}

/**
 * Returns the current kill state, or null if not killed. Reads from disk so
 * a flag dropped externally (e.g. ops script) takes effect on next check.
 */
export function readKillState() {
  if (!fs.existsSync(FLAG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(FLAG_FILE, "utf8"));
  } catch {
    // Unreadable flag file = still killed (fail-safe), surface a generic reason.
    return { reason: "unknown", detail: "flag file unreadable" };
  }
}

export function isKilled() {
  return readKillState() !== null;
}

/**
 * Clear the kill state. Deletes the flag file; in-memory counters also reset
 * so the bot starts fresh.
 */
export function reset() {
  try {
    if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE);
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch (e) {
    log("kill_switch_error", `Failed to clear kill switch state: ${e.message}`);
  }
  _consecutiveErrors = 0;
  _sessionStartUsd = null;
  log("kill_switch", "Kill switch reset");
}

// ─── Test helpers ────────────────────────────────────────────────

export function _resetForTests() {
  _sessionStartUsd = null;
  _consecutiveErrors = 0;
  if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE);
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
