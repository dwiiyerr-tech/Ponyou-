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
import { atomicWriteJson } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLAG_FILE = path.join(__dirname, "kill-switch.flag");
const STATE_FILE = new URL("./kill-switch-state.json", import.meta.url).pathname;

const DEFAULT_LIMITS = {
  drawdown_pct: -15,        // session drawdown trip-point (tighter: 15% not 20%)
  consecutive_errors: 3,    // consecutive swap failures trip-point (3, not 5)
};

// ─── In-memory state (rebuilt every restart; flag file is the source of truth) ───
let _sessionStartUsd = null;
let _consecutiveErrors = 0;

// Baseline stabilization: collect N readings over M seconds before locking in
// the session baseline. This prevents a transient dip (swap in flight, RPC
// blip) from setting an artificially low baseline that would false-trip later.
const BASELINE_WARMUP_READINGS = 5;
const BASELINE_WARMUP_INTERVAL_MS = 10_000; // 10 s between readings → 50 s total
let _baselineReadings = [];
let _baselineWarmupTimer = null;
let _baselineLocked = false;

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
  atomicWriteJson(STATE_FILE, payload);
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
  if (saved.tripAt && Number.isFinite(saved.sessionBaseline) && saved.sessionBaseline > 0) {
    try {
      if (!fs.existsSync(FLAG_FILE)) {
        atomicWriteJson(FLAG_FILE, {
          tripped_at: saved.tripAt,
          reason: "restored",
          detail: "Restored from kill-switch state file",
        });
      }
    } catch (e) {
      log("kill_switch_error", `Failed to restore flag: ${e.message}`);
    }
  } else if (saved.tripAt && (!Number.isFinite(saved.sessionBaseline) || saved.sessionBaseline <= 0)) {
    log("kill_switch", `Skipping trip restore: no valid baseline found (baseline=${saved.sessionBaseline})`);
  }
}

_restoreState();

/**
 * Snapshot session-start balance. Called once at startup.
 * An explicit call to setSessionBaseline bypasses the warmup period and
 * immediately locks the baseline — the caller has already validated the
 * balance reading.
 */
export function setSessionBaseline(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return;
  _sessionStartUsd = usd;
  _baselineLocked = true;
  _baselineReadings = [];
  _persistState();
}

/**
 * Feed a balance reading into the baseline stabilizer.
 * Called every cycle by index.js. The baseline only locks after
 * BASELINE_WARMUP_READINGS consecutive readings within 10% of each other,
 * ruling out transient dips or in-flight swap effects.
 */
export function reportBalance(usd, limits = DEFAULT_LIMITS) {
  if (!Number.isFinite(usd) || usd <= 0) return false;

  // If baseline already locked (via setSessionBaseline or prior warmup),
  // skip straight to drawdown check.
  if (_baselineLocked) {
    if (_sessionStartUsd == null || _sessionStartUsd <= 0) return false;
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

  // Warmup: collect readings until stable
  if (!_baselineLocked) {
    _baselineReadings.push(usd);
    if (_baselineReadings.length >= BASELINE_WARMUP_READINGS) {
      const recent = _baselineReadings.slice(-BASELINE_WARMUP_READINGS);
      const max = Math.max(...recent);
      const min = Math.min(...recent);
      // Readings must be within 10% spread to lock baseline
      if (min > 0 && (max - min) / min < 0.10) {
        _baselineLocked = true;
        _sessionStartUsd = Math.max(_sessionStartUsd || 0, max); // use peak of stable window
        _persistState();
        log("kill_switch", `Baseline locked at $${_sessionStartUsd.toFixed(2)} after ${_baselineReadings.length} readings (spread ${((max-min)/min*100).toFixed(1)}%)`);
        _baselineReadings = [];
      } else if (_baselineReadings.length > BASELINE_WARMUP_READINGS * 3) {
        // 3x readings still unstable — force lock at the max reading
        _baselineLocked = true;
        _sessionStartUsd = Math.max(..._baselineReadings);
        _persistState();
        log("kill_switch", `Baseline force-locked at $${_sessionStartUsd.toFixed(2)} after ${_baselineReadings.length} unstable readings`);
        _baselineReadings = [];
      }
    }
    return false; // no kill check during warmup
  }

  // Normal check after baseline locked
  if (_sessionStartUsd == null || _sessionStartUsd <= 0) return false;
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
    atomicWriteJson(FLAG_FILE, payload);
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
  _baselineReadings = [];
  _baselineLocked = false;
  if (_baselineWarmupTimer) { clearTimeout(_baselineWarmupTimer); _baselineWarmupTimer = null; }
  log("kill_switch", "Kill switch reset");
}

// ─── Test helpers ────────────────────────────────────────────────

export function _resetForTests() {
  if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE);
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  _consecutiveErrors = 0;
  _sessionStartUsd = null;
  _baselineReadings = [];
  _baselineLocked = false;
  if (_baselineWarmupTimer) { clearTimeout(_baselineWarmupTimer); _baselineWarmupTimer = null; }
}
