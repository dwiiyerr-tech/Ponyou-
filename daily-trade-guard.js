import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "daily-trade-guard-state.json");

function dateKey(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function defaultState(nowMs = Date.now()) {
  return {
    date: dateKey(nowMs),
    trades: 0,
    wins: 0,
    losses: 0,
    status: "running", // running | pending_decision | continued | stopped
    pendingDecision: null,
    acknowledgedThresholds: [],
    lastDecision: null,
    events: [],
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function loadState(nowMs = Date.now()) {
  if (!fs.existsSync(STATE_FILE)) return defaultState(nowMs);
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return defaultState(nowMs);
    if (parsed.date !== dateKey(nowMs)) {
      // DTG-4: surface that a pending decision crossed the day boundary
      // and is being discarded. Without this log, operators didn't know
      // an unresolved /continue|/stop went away after midnight UTC.
      if (parsed.pendingDecision) {
        // Best-effort log; this module avoids importing logger to keep
        // it lightweight for tests.
        try {
          console.warn(`[daily_trade_guard] Date rolled (${parsed.date} → ${dateKey(nowMs)}) with pending decision ${parsed.pendingDecision.id || "?"} — discarded`);
        } catch (_) {}
      }
      return defaultState(nowMs);
    }
    return {
      ...defaultState(nowMs),
      ...parsed,
      acknowledgedThresholds: Array.isArray(parsed.acknowledgedThresholds)
        ? parsed.acknowledgedThresholds
        : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return defaultState(nowMs);
  }
}

function saveState(state, nowMs = Date.now()) {
  const next = {
    ...state,
    updatedAt: new Date(nowMs).toISOString(),
  };
  atomicWriteJson(STATE_FILE, next);
  return next;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function normalizeDailyTradeGuardConfig(cfg = {}) {
  return {
    enabled: cfg.enabled === true,
    maxWinsPerDay: positiveInt(cfg.maxWinsPerDay ?? cfg.maxDailyWins, 3),
    maxLossesPerDay: positiveInt(cfg.maxLossesPerDay ?? cfg.maxDailyLosses, 3),
    learningModeDurationMin: positiveInt(cfg.learningModeDurationMin, 60),
  };
}

function thresholdKey(type, limit) {
  return `${type}:${limit}`;
}

function compactEvent(event) {
  return {
    ts: event.ts,
    type: event.type,
    threshold: event.threshold,
    count: event.count,
    limit: event.limit,
    symbol: event.symbol,
    mint: event.mint,
    pnl_pct: event.pnl_pct,
  };
}

function publicStatus(state, cfg) {
  return {
    enabled: cfg.enabled,
    date: state.date,
    trades: state.trades || 0,
    wins: state.wins || 0,
    losses: state.losses || 0,
    max_wins_per_day: cfg.maxWinsPerDay,
    max_losses_per_day: cfg.maxLossesPerDay,
    status: state.status || "running",
    pending_decision: state.pendingDecision || null,
    last_decision: state.lastDecision || null,
    blocked: cfg.enabled && ["pending_decision", "stopped"].includes(state.status),
  };
}

export function getDailyTradeGuardStatus(guardConfig = {}, options = {}) {
  const cfg = normalizeDailyTradeGuardConfig(guardConfig);
  const state = loadState(options.nowMs);
  return publicStatus(state, cfg);
}

export function recordDailyTradeOutcome(isWin, meta = {}, guardConfig = {}, options = {}) {
  // DTG-1: serialize the read-modify-write under a file lock so two parallel
  // exits resolving in the same tick can't both load the same baseline,
  // both increment, and both save — losing one increment. Without this
  // the daily guard could miss a threshold and let the bot over-trade.
  return withFileLock(STATE_FILE, async () => {
    const cfg = normalizeDailyTradeGuardConfig(guardConfig);
    const nowMs = options.nowMs ?? Date.now();
    let state = loadState(nowMs);

    if (!cfg.enabled || typeof isWin !== "boolean") {
      return { ...publicStatus(state, cfg), triggered: false };
    }

    const outcomeType = isWin ? "win" : "loss";
    state.trades = (state.trades || 0) + 1;
    if (isWin) state.wins = (state.wins || 0) + 1;
    else state.losses = (state.losses || 0) + 1;

    const count = isWin ? state.wins : state.losses;
    const limit = isWin ? cfg.maxWinsPerDay : cfg.maxLossesPerDay;
    const key = thresholdKey(outcomeType, limit);
    const alreadyAcknowledged = (state.acknowledgedThresholds || []).includes(key);
    const canTrigger = state.status !== "pending_decision" && state.status !== "stopped";
    const triggered = count >= limit && !alreadyAcknowledged && canTrigger;

    if (triggered) {
      state.status = "pending_decision";
      state.pendingDecision = {
        id: `${state.date}-${outcomeType}-${limit}`,
        threshold: outcomeType,
        count,
        limit,
        triggeredAt: new Date(nowMs).toISOString(),
        symbol: meta.symbol || null,
        mint: meta.mint || null,
        pnl_pct: Number.isFinite(meta.pnl_pct) ? meta.pnl_pct : null,
        exit_reason: meta.exit_reason || null,
      };
      state.events.push(compactEvent({
        ts: new Date(nowMs).toISOString(),
        type: "threshold_hit",
        threshold: outcomeType,
        count,
        limit,
        symbol: meta.symbol || null,
        mint: meta.mint || null,
        pnl_pct: Number.isFinite(meta.pnl_pct) ? meta.pnl_pct : null,
      }));
    }

    if (state.events.length > 100) state.events = state.events.slice(-100);
    state = saveState(state, nowMs);
    return {
      ...publicStatus(state, cfg),
      triggered,
      threshold: triggered ? outcomeType : null,
      count,
      limit,
    };
  });
}

export function decideDailyTradeGuard(action, guardConfig = {}, options = {}) {
  const cfg = normalizeDailyTradeGuardConfig(guardConfig);
  const nowMs = options.nowMs ?? Date.now();
  let state = loadState(nowMs);
  const normalized = String(action || "").toLowerCase();

  if (normalized === "continue") {
    const pending = state.pendingDecision;
    if (pending) {
      const key = thresholdKey(pending.threshold, pending.limit);
      if (!state.acknowledgedThresholds.includes(key)) {
        state.acknowledgedThresholds.push(key);
      }
    }
    state.status = "continued";
    state.lastDecision = {
      action: "continue",
      decidedAt: new Date(nowMs).toISOString(),
      pendingDecision: pending || null,
    };
    state.pendingDecision = null;
  } else if (normalized === "stop") {
    const pending = state.pendingDecision;
    state.status = "stopped";
    state.lastDecision = {
      action: "stop",
      decidedAt: new Date(nowMs).toISOString(),
      pendingDecision: pending || null,
    };
    state.pendingDecision = null;
  } else if (normalized === "reset") {
    state = defaultState(nowMs);
  } else {
    return {
      ...publicStatus(state, cfg),
      changed: false,
      error: "unknown_action",
    };
  }

  state = saveState(state, nowMs);
  return { ...publicStatus(state, cfg), changed: true };
}

export function isDailyTradeGuardEntryBlocked(guardConfig = {}, options = {}) {
  const status = getDailyTradeGuardStatus(guardConfig, options);
  if (!status.enabled || !status.blocked) return { blocked: false, status };

  const pending = status.pending_decision;
  const reason = status.status === "pending_decision"
    ? `DAILY_TRADE_GUARD: ${pending?.threshold || "limit"} limit ${pending?.count || "?"}/${pending?.limit || "?"} needs /continue or /stoptrade`
    : "DAILY_TRADE_GUARD: trading stopped for today";

  return { blocked: true, reason, status };
}

export function _resetDailyTradeGuardForTests() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}
