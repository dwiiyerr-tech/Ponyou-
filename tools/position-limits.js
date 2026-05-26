/**
 * Per-Strategy Position Limits — manual or Kelly-formula based.
 *
 * Manual mode: user sets max open positions per strategy directly.
 * Kelly mode:   calculated from historical win rate × profit factor.
 *
 * Each strategy config:
 *   maxPositions      — max concurrent open positions (1–20)
 *   minSolToActivate  — minimum SOL balance to allow opening (0 = no minimum)
 *   maxPerCoin        — max entries per same token mint (1–10, default 1)
 *
 * Kelly for position count:
 *   K% = W - ((1-W) / R)
 *   position_limit = max(1, round(kellyFraction × K% × base_cap))
 *
 *   where W = win_rate, R = avg_win / avg_loss, base_cap = 12
 */

import { config } from "../config.js";
import { getActiveStrategy } from "../strategies.js";
import { getPerformanceHistory } from "../lessons.js";
import { getState } from "../state.js";
import { log } from "../logger.js";

// ─── Defaults ───────────────────────────────────────────

const DEFAULT_POSITION_LIMITS = {
  mode: "manual",
  kellyFraction: 0.5,
  perStrategy: {
    scalp:            { maxPositions: 3, minSolToActivate: 0.5, maxPerCoin: 1 },
    sniper:           { maxPositions: 2, minSolToActivate: 1.0, maxPerCoin: 1 },
    dip_buy:          { maxPositions: 3, minSolToActivate: 1.0, maxPerCoin: 1 },
    conservative:     { maxPositions: 4, minSolToActivate: 2.0, maxPerCoin: 1 },
    aggressive:       { maxPositions: 2, minSolToActivate: 0.3, maxPerCoin: 1 },
    recovery:         { maxPositions: 1, minSolToActivate: 2.0, maxPerCoin: 1 },
    day_phase_swing:  { maxPositions: 3, minSolToActivate: 1.5, maxPerCoin: 1 },
  },
};

const MAX_POSITIONS_CAP = 12;

// ─── Kelly Calculator ───────────────────────────────────

/**
 * Compute Kelly-optimal position count from historical performance.
 *
 * K% = W - ((1-W) / R)
 * positions = max(1, round(kellyFraction × K% × base_cap))
 *
 * Returns 0 if not enough data.
 */
export function computeKellyPositions({
  winRate = null,
  avgWinPct = null,
  avgLossPct = null,
  kellyFraction = 0.5,
  minTrades = 10,
  baseCap = MAX_POSITIONS_CAP,
} = {}) {
  // Get historical data if not provided
  if (winRate === null || avgWinPct === null || avgLossPct === null) {
    const history = getPerformanceHistory({ limit: 100 });
    const closed = history.filter(t => t.pnl_pct !== undefined && t.pnl_pct !== null);

    if (closed.length < minTrades) {
      return { positions: 1, kellyPct: 0, reason: `insufficient_data_need_${minTrades}`, dataPoints: closed.length };
    }

    const wins = closed.filter(t => (t.pnl_pct || 0) > 0);
    const losses = closed.filter(t => (t.pnl_pct || 0) < 0);

    if (losses.length === 0) {
      // All wins — maximum confidence
      const kellyPct = Math.min(0.95, winRate ?? (wins.length / closed.length));
      const positions = Math.max(1, Math.round(kellyFraction * kellyPct * baseCap));
      return { positions, kellyPct, reason: "all_wins", dataPoints: closed.length };
    }

    const w = wins.length / closed.length;
    const avgWin = wins.reduce((s, t) => s + (t.pnl_pct || 0), 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl_pct || 0), 0) / losses.length);

    winRate = w;
    avgWinPct = avgWin;
    avgLossPct = avgLoss;
  }

  if (avgLossPct === 0 || avgWinPct === 0) {
    return { positions: 1, kellyPct: 0, reason: "zero_pnl_data" };
  }

  const R = avgWinPct / avgLossPct;
  const kellyPct = Math.max(0, Math.min(0.95, winRate - ((1 - winRate) / R)));

  // Kelly fraction scaling: multiply the raw Kelly % by user's chosen fraction
  const positions = Math.max(1, Math.round(kellyFraction * kellyPct * baseCap));

  return {
    positions: Math.min(positions, MAX_POSITIONS_CAP),
    kellyPct: +(kellyPct * 100).toFixed(1),
    winRate: +(winRate * 100).toFixed(1),
    avgWinPct: +avgWinPct.toFixed(1),
    avgLossPct: +avgLossPct.toFixed(1),
    R: +R.toFixed(2),
    kellyFraction,
    reason: "computed",
  };
}

// ─── Helpers ────────────────────────────────────────────

/**
 * Normalize a per-strategy entry to the full object format.
 * Supports legacy number format (maxPositions only).
 */
function normalizeStrategyEntry(entry, fallback) {
  if (typeof entry === "number") {
    return { maxPositions: entry, minSolToActivate: 0.5, maxPerCoin: 1 };
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return {
      maxPositions: entry.maxPositions ?? fallback.maxPositions ?? 3,
      minSolToActivate: entry.minSolToActivate ?? fallback.minSolToActivate ?? 0.5,
      maxPerCoin: entry.maxPerCoin ?? fallback.maxPerCoin ?? 1,
    };
  }
  return { ...fallback };
}

function getStrategyConfig(strategyId = null) {
  const cfg = { ...DEFAULT_POSITION_LIMITS, ...(config.positionLimits || {}) };
  const strategy = strategyId || getActiveStrategy()?.id || "scalp";
  const defaults = DEFAULT_POSITION_LIMITS.perStrategy[strategy] || DEFAULT_POSITION_LIMITS.perStrategy.scalp;
  const userEntry = cfg.perStrategy?.[strategy];
  return normalizeStrategyEntry(userEntry, defaults);
}

// ─── Per-Strategy Accessors ────────────────────────────

/**
 * Get max open positions for a strategy (manual or Kelly-adjusted).
 */
export function getStrategyPositionLimit(strategyId = null) {
  const cfg = { ...DEFAULT_POSITION_LIMITS, ...(config.positionLimits || {}) };
  const strategy = strategyId || getActiveStrategy()?.id || "scalp";
  const sc = getStrategyConfig(strategy);
  let baseLimit = sc.maxPositions;

  if (cfg.mode === "kelly") {
    const kelly = computeKellyPositions({ kellyFraction: cfg.kellyFraction || 0.5 });
    if (kelly.positions > 0) {
      const mult = getStrategyRiskMultiplier(strategy);
      baseLimit = Math.max(1, Math.round(kelly.positions * mult));
      log("position_limits", [
        `Kelly: W=${kelly.winRate}% R=${kelly.R} K%=${kelly.kellyPct}%`,
        `strategy=${strategy} mult=${mult} → ${baseLimit} pos`,
      ].join(" | "));
    }
  }

  return Math.min(baseLimit, MAX_POSITIONS_CAP);
}

/**
 * Get minimum SOL balance required to allow opening positions for this strategy.
 * Returns 0 if no minimum (always allow).
 */
export function getStrategyMinSolToActivate(strategyId = null) {
  return getStrategyConfig(strategyId).minSolToActivate;
}

/**
 * Get max entries allowed for the same token mint.
 * Default 1 = no double-dipping.
 */
export function getStrategyMaxPerCoin(strategyId = null) {
  return getStrategyConfig(strategyId).maxPerCoin;
}

/**
 * Check if a token can be entered based on current open positions for that token.
 * Returns { allowed, reason }.
 */
export function canEnterToken(tokenMint, strategyId = null) {
  if (!tokenMint) return { allowed: true, reason: "no_mint" };

  const maxPerCoin = getStrategyMaxPerCoin(strategyId);
  if (maxPerCoin <= 0) return { allowed: true }; // unlimited

  const positions = Object.values(getState()?.positions || {});
  const openForToken = positions.filter(
    p => !p?.closed && (p?.mint === tokenMint || p?.token === tokenMint)
  );
  const count = openForToken.length;

  if (count >= maxPerCoin) {
    return {
      allowed: false,
      reason: `max_per_coin_reached: ${count}/${maxPerCoin} positions for this token`,
    };
  }
  return { allowed: true };
}

/**
 * Check if wallet has enough SOL to activate position opening.
 * Returns { canOpen, reason, requiredSol, currentSol }.
 */
export function canActivateStrategy(walletSol, strategyId = null) {
  const minSol = getStrategyMinSolToActivate(strategyId);
  if (minSol <= 0) return { canOpen: true, reason: "no_minimum" };

  if (walletSol < minSol) {
    return {
      canOpen: false,
      reason: `insufficient_sol: need ${minSol} SOL, have ${walletSol.toFixed(3)} SOL`,
      requiredSol: minSol,
      currentSol: walletSol,
    };
  }
  return { canOpen: true, reason: "ok" };
}

// ─── Risk Multipliers ──────────────────────────────────

function getStrategyRiskMultiplier(strategyId) {
  const multipliers = {
    scalp: 1.2,
    sniper: 0.6,
    dip_buy: 1.0,
    conservative: 1.5,
    aggressive: 0.5,
    recovery: 0.3,
    day_phase_swing: 0.8,
  };
  return multipliers[strategyId] || 1.0;
}

// ─── Position Limit Config ─────────────────────────────

export function getPositionLimitsConfig() {
  const raw = { ...DEFAULT_POSITION_LIMITS, ...(config.positionLimits || {}) };
  // Normalize all perStrategy entries to object format
  const mergedPerStrategy = { ...DEFAULT_POSITION_LIMITS.perStrategy, ...(raw.perStrategy || {}) };
  const normalized = {};
  for (const [id, entry] of Object.entries(mergedPerStrategy)) {
    const def = DEFAULT_POSITION_LIMITS.perStrategy[id] || { maxPositions: 3, minSolToActivate: 0.5, maxPerCoin: 1 };
    normalized[id] = normalizeStrategyEntry(entry, def);
  }
  return { ...raw, perStrategy: normalized };
}

export function getPositionLimitDashboard() {
  const cfg = getPositionLimitsConfig();
  const activeStrategy = getActiveStrategy();
  const strategy = activeStrategy?.id || "scalp";
  const currentLimit = getStrategyPositionLimit(strategy);
  const currentMinSol = getStrategyMinSolToActivate(strategy);
  const currentMaxPerCoin = getStrategyMaxPerCoin(strategy);
  let kellyInfo = null;

  if (cfg.mode === "kelly") {
    kellyInfo = computeKellyPositions({ kellyFraction: cfg.kellyFraction || 0.5 });
  }

  const perStrategyLimits = Object.entries(cfg.perStrategy).map(([id, entry]) => {
    const e = normalizeStrategyEntry(entry, { maxPositions: 3, minSolToActivate: 0.5, maxPerCoin: 1 });
    return {
      id,
      maxPositions: e.maxPositions,
      minSolToActivate: e.minSolToActivate,
      maxPerCoin: e.maxPerCoin,
      multiplier: getStrategyRiskMultiplier(id),
      effectiveKellyLimit: cfg.mode === "kelly" && kellyInfo
        ? Math.max(1, Math.round(kellyInfo.positions * getStrategyRiskMultiplier(id)))
        : null,
    };
  });

  return {
    config: cfg,
    activeStrategy: strategy,
    currentLimit,
    currentMinSol,
    currentMaxPerCoin,
    kellyInfo,
    perStrategyLimits,
  };
}
