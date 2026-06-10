/**
 * capital-guard.js — 4-layer capital protection with timed cooldowns.
 *
 * Layer 1 (daily soft):    daily PnL ≤ -5%  → block new entries 60 min (auto-resume)
 * Layer 2 (daily hard):    daily PnL ≤ -10% → block entries until midnight UTC
 * Layer 3 (peak drawdown): equity dd ≥ -25% from peak → block 24 h
 * Layer 4 (halt):          daily PnL ≤ -30% → trip kill switch permanently
 *
 * Complements existing protection:
 *   adaptive-risk.js  — soft size multiplier, stateless
 *   kill-switch.js    — session drawdown -15% permanent halt + swap errors
 *   capital-guard.js  — timed daily/peak cooldowns (this module)
 *
 * All thresholds are operator-configurable via config.capitalGuard.
 * Defaults are OFF (enabled: false) to avoid breaking existing behaviour.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { trip as tripKillSwitch } from "./kill-switch.js";
import { recordCounter } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE =
  process.env.PONYOU_CAPITAL_GUARD_STATE ||
  path.join(__dirname, "capital-guard-state.json");

export const LAYER_DEFAULTS = {
  layer1DailyPct:  -5,   // soft pause threshold (%)
  layer2DailyPct:  -10,  // hard daily pause threshold (%)
  layer3PeakDdPct: -25,  // peak drawdown pause threshold (%)
  layer4HaltPct:   -30,  // catastrophic daily loss → kill switch (%)
  layer1PauseMin:  60,   // pause duration for layer 1 (minutes)
};

function utcDateKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextMidnightUtc(ms = Date.now()) {
  const d = new Date(ms);
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

function defaultState(nowMs = Date.now()) {
  return {
    dailyDate: utcDateKey(nowMs),
    dailyStartUsd: null,
    peakCapitalUsd: null,
    lastCapitalUsd: null, // most recent reported balance — used by status + operator reset
    layer1: null,        // null = not tripped; { trippedAt, resumeAt }
    layer2: null,
    layer3: null,
    layer4Tripped: false,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function loadState(nowMs = Date.now()) {
  if (!fs.existsSync(STATE_FILE)) return defaultState(nowMs);
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return defaultState(nowMs);
    if (parsed.dailyDate !== utcDateKey(nowMs)) {
      // Daily rollover: keep peak, reset daily counters + layer1/2
      return {
        ...defaultState(nowMs),
        peakCapitalUsd: parsed.peakCapitalUsd || null,
        lastCapitalUsd: parsed.lastCapitalUsd || null,
        // layer3 (peak drawdown) survives day boundary if still active
        layer3: parsed.layer3 || null,
        // layer4 is a permanent halt — it must NOT silently clear at midnight.
        // The kill switch holds independently, but status reporting and the
        // re-trip guard in reportCapital() rely on this flag surviving.
        layer4Tripped: parsed.layer4Tripped === true,
      };
    }
    return { ...defaultState(nowMs), ...parsed };
  } catch {
    return defaultState(nowMs);
  }
}

function persistState(state, nowMs = Date.now()) {
  const next = { ...state, updatedAt: new Date(nowMs).toISOString() };
  atomicWriteJson(STATE_FILE, next);
  return next;
}

let _state = null;

function getState(nowMs = Date.now()) {
  if (!_state || _state.dailyDate !== utcDateKey(nowMs)) {
    _state = loadState(nowMs);
  }
  return _state;
}

/**
 * Seed or refresh the daily-start baseline and peak tracking.
 * Idempotent for daily-start (only sets once per UTC day).
 * Always updates peak upward if currentUsd is higher.
 * Call at startup and after confirmed wallet balance reads.
 */
export function initCapitalGuard(currentUsd, nowMs = Date.now()) {
  if (!Number.isFinite(currentUsd) || currentUsd <= 0) return;
  const state = getState(nowMs);
  let changed = false;

  if (!state.dailyStartUsd || state.dailyStartUsd <= 0) {
    state.dailyStartUsd = currentUsd;
    changed = true;
  }
  if (!state.peakCapitalUsd || currentUsd > state.peakCapitalUsd) {
    state.peakCapitalUsd = currentUsd;
    changed = true;
  }
  if (state.lastCapitalUsd !== currentUsd) {
    state.lastCapitalUsd = currentUsd;
    changed = true;
  }
  if (changed) {
    _state = persistState(state, nowMs);
  }
}

/**
 * Report current capital and check all 4 layers.
 * Call every cycle alongside kill-switch's reportBalance().
 * Returns the FIRST newly-tripped layer, or { tripped: false }.
 *
 * @param {number} currentUsd
 * @param {object} cfg — override any of LAYER_DEFAULTS
 * @param {number} nowMs
 * @returns {{ tripped: boolean, level?: number, reason?: string }}
 */
export function reportCapital(currentUsd, cfg = {}, nowMs = Date.now()) {
  if (!Number.isFinite(currentUsd) || currentUsd <= 0) return { tripped: false };

  const limits = { ...LAYER_DEFAULTS, ...cfg };
  const state = getState(nowMs);

  // Update peak (never decreases)
  let changed = false;
  if (!state.peakCapitalUsd || currentUsd > state.peakCapitalUsd) {
    state.peakCapitalUsd = currentUsd;
    changed = true;
  }
  if (!state.dailyStartUsd || state.dailyStartUsd <= 0) {
    state.dailyStartUsd = currentUsd;
    changed = true;
  }
  if (state.lastCapitalUsd !== currentUsd) {
    state.lastCapitalUsd = currentUsd;
    changed = true;
  }
  if (changed) {
    _state = persistState(state, nowMs);
  }

  const dailyPct = state.dailyStartUsd > 0
    ? ((currentUsd - state.dailyStartUsd) / state.dailyStartUsd) * 100
    : 0;
  const peakPct = state.peakCapitalUsd > 0
    ? ((currentUsd - state.peakCapitalUsd) / state.peakCapitalUsd) * 100
    : 0;

  // Kill switch already active from a prior layer 4 trip — no further action.
  if (state.layer4Tripped) return { tripped: false };

  // Layer 4 — catastrophic daily loss → permanent kill switch trip
  if (!state.layer4Tripped && dailyPct <= limits.layer4HaltPct) {
    const reason = `Daily loss ${dailyPct.toFixed(2)}% ≤ halt threshold ${limits.layer4HaltPct}%`;
    tripKillSwitch({ reason: "capital_guard_layer4", detail: reason });
    state.layer4Tripped = true;
    _state = persistState(state, nowMs);
    recordCounter("capital_guard_layer4_trip");
    log("capital_guard", `🛑 Layer 4 (permanent halt): ${reason}`);
    return { tripped: true, level: 4, reason };
  }

  // Layer 3 — peak drawdown (24 h cooldown)
  if (!state.layer3 && peakPct <= limits.layer3PeakDdPct) {
    const resumeAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
    const reason = `Peak drawdown ${peakPct.toFixed(2)}% ≤ ${limits.layer3PeakDdPct}%`;
    state.layer3 = { trippedAt: new Date(nowMs).toISOString(), resumeAt };
    _state = persistState(state, nowMs);
    recordCounter("capital_guard_layer3_trip");
    log("capital_guard", `⛔ Layer 3 (24 h cooldown): ${reason}`);
    return { tripped: true, level: 3, reason };
  }

  // Layer 2 — daily hard stop (until midnight UTC)
  if (!state.layer2 && dailyPct <= limits.layer2DailyPct) {
    const resumeAt = nextMidnightUtc(nowMs);
    const reason = `Daily loss ${dailyPct.toFixed(2)}% ≤ ${limits.layer2DailyPct}%`;
    state.layer2 = { trippedAt: new Date(nowMs).toISOString(), resumeAt };
    _state = persistState(state, nowMs);
    recordCounter("capital_guard_layer2_trip");
    log("capital_guard", `🔴 Layer 2 (pause until midnight): ${reason}`);
    return { tripped: true, level: 2, reason };
  }

  // Layer 1 — daily soft stop (timed pause)
  if (!state.layer1 && dailyPct <= limits.layer1DailyPct) {
    const resumeAt = new Date(nowMs + limits.layer1PauseMin * 60 * 1000).toISOString();
    const reason = `Daily loss ${dailyPct.toFixed(2)}% ≤ ${limits.layer1DailyPct}%`;
    state.layer1 = { trippedAt: new Date(nowMs).toISOString(), resumeAt };
    _state = persistState(state, nowMs);
    recordCounter("capital_guard_layer1_trip");
    log("capital_guard", `🟡 Layer 1 (${limits.layer1PauseMin} min pause): ${reason}`);
    return { tripped: true, level: 1, reason };
  }

  return { tripped: false };
}

/**
 * Query whether capital guard is blocking new entries right now.
 * Clears expired layer cooldowns automatically.
 * Returns { blocked: false } when all clear.
 *
 * @param {number} nowMs
 * @returns {{ blocked: boolean, level?: number, reason?: string, resume_at?: string }}
 */
export function checkCapitalGuard(nowMs = Date.now()) {
  const state = getState(nowMs);

  // Layer 4 — permanent halt (kill switch already tripped; surface as blocked
  // so the status API and dashboard correctly reflect the halted state)
  if (state.layer4Tripped) {
    return { blocked: true, level: 4, reason: "Permanent halt — reset kill switch to resume" };
  }

  // Layer 3 — peak drawdown (highest severity after kill switch)
  if (state.layer3) {
    const resumeMs = new Date(state.layer3.resumeAt).getTime();
    if (nowMs < resumeMs) {
      const minLeft = Math.ceil((resumeMs - nowMs) / 60_000);
      return {
        blocked: true, level: 3,
        reason: `Peak drawdown halt — resume in ${minLeft} min`,
        resume_at: state.layer3.resumeAt,
      };
    }
    // Expired — auto-clear
    state.layer3 = null;
    _state = persistState(state, nowMs);
  }

  // Layer 2 — daily hard stop
  if (state.layer2) {
    const resumeMs = new Date(state.layer2.resumeAt).getTime();
    if (nowMs < resumeMs) {
      const minLeft = Math.ceil((resumeMs - nowMs) / 60_000);
      return {
        blocked: true, level: 2,
        reason: `Daily hard stop — resume in ${minLeft} min (midnight UTC)`,
        resume_at: state.layer2.resumeAt,
      };
    }
    state.layer2 = null;
    _state = persistState(state, nowMs);
  }

  // Layer 1 — soft pause
  if (state.layer1) {
    const resumeMs = new Date(state.layer1.resumeAt).getTime();
    if (nowMs < resumeMs) {
      const minLeft = Math.ceil((resumeMs - nowMs) / 60_000);
      return {
        blocked: true, level: 1,
        reason: `Daily soft stop — resume in ${minLeft} min`,
        resume_at: state.layer1.resumeAt,
      };
    }
    state.layer1 = null;
    _state = persistState(state, nowMs);
  }

  return { blocked: false };
}

/**
 * Operator reset for layers 1–3.
 * Layer 4 trips the kill switch; reset it via kill-switch.js reset().
 *
 * Resetting also REBASES the layer's baseline to the last reported capital —
 * without this the very next reportCapital() would re-trip the same layer,
 * because the underlying daily-loss / peak-drawdown condition still holds:
 *   layer 1/2 → dailyStartUsd := lastCapitalUsd (daily PnL restarts at 0%)
 *   layer 3   → peakCapitalUsd := lastCapitalUsd (drawdown restarts at 0%)
 * This is an explicit operator override; the trade-off is that the rest of
 * today's loss (or the prior peak) is forgiven for guard purposes.
 *
 * Returns true if the layer existed and was cleared, false otherwise.
 */
export function resetCapitalGuardLayer(layerNum, nowMs = Date.now()) {
  const state = getState(nowMs);
  const key = `layer${layerNum}`;
  if (![1, 2, 3].includes(layerNum) || !(key in state)) return false;
  if (!state[key]) return false;
  state[key] = null;
  const rebase = Number.isFinite(state.lastCapitalUsd) && state.lastCapitalUsd > 0
    ? state.lastCapitalUsd
    : null;
  if (rebase) {
    if (layerNum === 3) state.peakCapitalUsd = rebase;
    else state.dailyStartUsd = rebase;
  }
  _state = persistState(state, nowMs);
  log("capital_guard",
    `Layer ${layerNum} reset by operator` +
    (rebase ? ` — ${layerNum === 3 ? "peak" : "daily baseline"} rebased to $${rebase.toFixed(2)}` : ""));
  return true;
}

/**
 * Status snapshot for dashboard and /api/capital-guard.
 */
export function getCapitalGuardStatus(currentUsd = null, nowMs = Date.now()) {
  const state = getState(nowMs);
  const check = checkCapitalGuard(nowMs);

  // Fall back to the last reported balance so status callers (Telegram,
  // dashboard) get live percentages without having to fetch the wallet.
  if (!Number.isFinite(currentUsd) || currentUsd <= 0) {
    currentUsd = Number.isFinite(state.lastCapitalUsd) && state.lastCapitalUsd > 0
      ? state.lastCapitalUsd
      : null;
  }

  const dailyPct = state.dailyStartUsd > 0 && Number.isFinite(currentUsd) && currentUsd > 0
    ? Number(((currentUsd - state.dailyStartUsd) / state.dailyStartUsd * 100).toFixed(2))
    : null;
  const peakDdPct = state.peakCapitalUsd > 0 && Number.isFinite(currentUsd) && currentUsd > 0
    ? Number(((currentUsd - state.peakCapitalUsd) / state.peakCapitalUsd * 100).toFixed(2))
    : null;

  return {
    blocked: check.blocked,
    active_level: check.blocked ? check.level : null,
    reason: check.reason || null,
    resume_at: check.resume_at || null,
    daily_date: state.dailyDate,
    daily_start_usd: state.dailyStartUsd,
    peak_capital_usd: state.peakCapitalUsd,
    current_usd: currentUsd,
    daily_pnl_pct: dailyPct,
    peak_dd_pct: peakDdPct,
    layer1: state.layer1,
    layer2: state.layer2,
    layer3: state.layer3,
    layer4_tripped: state.layer4Tripped,
  };
}

export function _resetCapitalGuardForTests() {
  _state = null;
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
