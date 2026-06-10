/**
 * streak-sizer.js — persistent compounding position-size multiplier.
 *
 * Each closed trade adjusts the multiplier:
 *   Win:  multiplier × (1 + winScaleUp)  — capped at maxMultiplier
 *   Loss: multiplier × (1 - lossScaleDown) — floored at minMultiplier
 *
 * The multiplier starts at 1.0 (neutral) and persists across restarts so the
 * bot enters each session with its earned context, not a blank slate.
 *
 * Applied AFTER Kelly/capital-aware sizing and ALONGSIDE adaptive-risk:
 *   adaptive-risk  — stateless step function, session-only, handles extreme states
 *   streak-sizer   — persistent compounding, normal win/loss rhythm
 *
 * Defaults (all overridable via config.streakSizer):
 *   lossScaleDown  = 0.20   (-20% per loss)
 *   winScaleUp     = 0.10   (+10% per win)
 *   minMultiplier  = 0.25   (floor: 25% of Kelly)
 *   maxMultiplier  = 1.50   (cap: 150% of Kelly)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { recordCounter } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE =
  process.env.PONYOU_STREAK_SIZER_STATE ||
  path.join(__dirname, "streak-sizer-state.json");

export const STREAK_DEFAULTS = {
  lossScaleDown:  0.20,
  winScaleUp:     0.10,
  minMultiplier:  0.25,
  maxMultiplier:  1.50,
};

function defaultState() {
  return {
    multiplier:    1.0,
    winStreak:     0,
    lossStreak:    0,
    totalWins:     0,
    totalLosses:   0,
    lastUpdatedAt: null,
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return defaultState();
    return {
      ...defaultState(),
      ...parsed,
      multiplier: Number.isFinite(parsed.multiplier) && parsed.multiplier > 0
        ? parsed.multiplier
        : 1.0,
    };
  } catch {
    return defaultState();
  }
}

let _state = null;

function getState() {
  if (!_state) _state = loadState();
  return _state;
}

function persistState(state) {
  const next = { ...state, lastUpdatedAt: new Date().toISOString() };
  atomicWriteJson(STATE_FILE, next);
  _state = next;
  return next;
}

/**
 * Record the outcome of a closed trade and adjust the streak multiplier.
 * Call once per closed position, after PnL is confirmed.
 *
 * @param {boolean} isWin
 * @param {object} [cfg] — override STREAK_DEFAULTS
 * @returns {{ multiplier, delta, winStreak, lossStreak }}
 */
export function recordStreakOutcome(isWin, cfg = {}) {
  const limits = { ...STREAK_DEFAULTS, ...cfg };
  const state = getState();
  const prev = state.multiplier;

  if (isWin) {
    state.winStreak  = (state.winStreak  || 0) + 1;
    state.lossStreak = 0;
    state.totalWins  = (state.totalWins  || 0) + 1;
    state.multiplier = Math.min(limits.maxMultiplier, prev * (1 + limits.winScaleUp));
    recordCounter("streak_sizer_win");
  } else {
    state.lossStreak = (state.lossStreak || 0) + 1;
    state.winStreak  = 0;
    state.totalLosses = (state.totalLosses || 0) + 1;
    state.multiplier = Math.max(limits.minMultiplier, prev * (1 - limits.lossScaleDown));
    recordCounter("streak_sizer_loss");
  }

  state.multiplier = Number(state.multiplier.toFixed(4));
  const delta = Number((state.multiplier - prev).toFixed(4));

  persistState(state);

  const dir = isWin ? "📈" : "📉";
  log("streak_sizer",
    `${dir} ${isWin ? "win" : "loss"} ` +
    `streak=${isWin ? state.winStreak : state.lossStreak} ` +
    `mult: ${prev.toFixed(3)}→${state.multiplier.toFixed(3)} (${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`
  );

  return {
    multiplier: state.multiplier,
    delta,
    winStreak:  state.winStreak,
    lossStreak: state.lossStreak,
  };
}

/**
 * Return the current sizing multiplier. 1.0 = neutral. < 1 = reduced. > 1 = increased.
 * Safe to call even when the module is disabled (returns 1.0).
 *
 * @param {object} [cfg] — override STREAK_DEFAULTS (only needed to validate bounds)
 * @returns {number}
 */
export function getStreakMultiplier(cfg = {}) {
  const limits = { ...STREAK_DEFAULTS, ...cfg };
  const state = getState();
  // Clamp in case the config changed since the state was written
  return Math.min(limits.maxMultiplier, Math.max(limits.minMultiplier, state.multiplier));
}

/**
 * Full status snapshot for dashboard/Telegram.
 */
export function getStreakStatus(cfg = {}) {
  const limits = { ...STREAK_DEFAULTS, ...cfg };
  const state = getState();
  const mult = Math.min(limits.maxMultiplier, Math.max(limits.minMultiplier, state.multiplier));
  return {
    multiplier:    Number(mult.toFixed(4)),
    win_streak:    state.winStreak  || 0,
    loss_streak:   state.lossStreak || 0,
    total_wins:    state.totalWins  || 0,
    total_losses:  state.totalLosses || 0,
    last_updated:  state.lastUpdatedAt || null,
    at_floor:      mult <= limits.minMultiplier,
    at_ceiling:    mult >= limits.maxMultiplier,
  };
}

/**
 * Operator reset — return multiplier to 1.0 and clear streaks.
 */
export function resetStreak() {
  const next = defaultState();
  persistState(next);
  log("streak_sizer", "Streak multiplier reset to 1.0 by operator");
}

export function _resetStreakForTests() {
  _state = null;
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
