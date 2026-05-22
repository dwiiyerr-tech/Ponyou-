/**
 * Trading Plan 30 — session trade counter with configurable target.
 * Tracks N trades per session; blocks new buys when target reached.
 * State persisted in trading-plan-state.json.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let STATE_FILE = path.join(__dirname, "trading-plan-state.json");

export function _setStateFile(filePath) {
  STATE_FILE = filePath;
}

function freshState(target) {
  return {
    session_id: Date.now().toString(36),
    trades_completed: 0,
    target: target ?? config.tradingPlan?.targetTrades ?? 30,
    started_at: new Date().toISOString(),
    completed_at: null,
    trade_log: [],
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return freshState();
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { ...freshState(data.target), ...data };
  } catch {
    return freshState();
  }
}

function saveState(state) {
  atomicWriteJson(STATE_FILE, state);
}

export function isTradingPlanEnabled() {
  return config.tradingPlan?.enabled ?? false;
}

export function getTradingPlanStatus() {
  const state = loadState();
  const enabled = isTradingPlanEnabled();
  const target = state.target;
  const remaining = Math.max(0, target - state.trades_completed);
  const progress_pct = target > 0
    ? parseFloat(((state.trades_completed / target) * 100).toFixed(1))
    : 0;
  return {
    enabled,
    trades_completed: state.trades_completed,
    target,
    remaining,
    progress_pct,
    session_complete: state.trades_completed >= target,
    started_at: state.started_at,
    completed_at: state.completed_at,
    session_id: state.session_id,
  };
}

export function initTradingPlan() {
  const state = loadState();
  if (!fs.existsSync(STATE_FILE)) saveState(state);
  return getTradingPlanStatus();
}

export function recordTrade({ symbol = "?", mint = "", pnl_pct = 0 } = {}) {
  if (!isTradingPlanEnabled()) return { skipped: true };
  const state = loadState();
  state.trades_completed += 1;
  state.trade_log.push({ symbol, mint, pnl_pct, ts: new Date().toISOString() });
  if (state.trade_log.length > 100) state.trade_log = state.trade_log.slice(-100);
  if (state.trades_completed >= state.target && !state.completed_at) {
    state.completed_at = new Date().toISOString();
  }
  saveState(state);
  return {
    count: state.trades_completed,
    target: state.target,
    complete: state.trades_completed >= state.target,
  };
}

export function resetTradingPlan() {
  const target = config.tradingPlan?.targetTrades ?? 30;
  const state = freshState(target);
  saveState(state);
  return getTradingPlanStatus();
}

export function isSessionComplete() {
  if (!isTradingPlanEnabled()) return false;
  const state = loadState();
  return state.trades_completed >= state.target;
}

export default {
  isTradingPlanEnabled,
  initTradingPlan,
  recordTrade,
  getTradingPlanStatus,
  resetTradingPlan,
  isSessionComplete,
};
