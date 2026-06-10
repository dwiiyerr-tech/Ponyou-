/**
 * smart-money-filter.js — canonical quality gate for copy-trade wallets.
 *
 * 4 criteria (all configurable, each gracefully skipped when data is absent):
 *   1. Win rate      ≥ minWinRate       (default 60%)
 *   2. Total trades  ≥ minTrades        (default 30)
 *   3. Profit factor ≥ minProfitFactor  (default 1.5) — skipped if 0/null
 *   4. Consistency   ≥ minConsistency   (default 60%) — recent win rate;
 *                                        falls back to lifetime win rate when
 *                                        per-trade breakdown is unavailable
 *
 * Profit factor = total_win_sol / abs(total_loss_sol).
 * Consistency   = wins / completed_trades from the most-recent scoring window
 *                 (Helius path exposes this directly; GMGN uses lifetime WR as proxy).
 *
 * Pure functions — no I/O, no side effects, sub-millisecond.
 */

export const FILTER_DEFAULTS = {
  minWinRate:      0.60,
  minTrades:       30,
  minProfitFactor: 1.5,
  minConsistency:  0.60,
};

/**
 * Compute profit factor from raw win/loss SOL totals.
 * Returns null when either value is missing or the denominator is zero.
 *
 * @param {number|null} totalWinSol   — sum of positive realized PnLs
 * @param {number|null} totalLossSol  — sum of absolute negative realized PnLs
 * @returns {number|null}
 */
export function computeProfitFactor(totalWinSol, totalLossSol) {
  if (!Number.isFinite(totalWinSol) || !Number.isFinite(totalLossSol)) return null;
  if (totalLossSol <= 0) return totalWinSol > 0 ? Infinity : null;
  return Number((totalWinSol / totalLossSol).toFixed(3));
}

/**
 * Derive a consistency score (0–1) from available stats.
 * Prefers a recent-window breakdown (wins + completed_trades) when present;
 * falls back to the lifetime win rate reported by the data source.
 *
 * @param {object} stats
 * @returns {number}  0–1
 */
export function computeConsistencyScore(stats = {}) {
  const wins  = stats.wins;
  const total = stats.completed_trades;
  if (Number.isFinite(wins) && Number.isFinite(total) && total > 0) {
    return Number((wins / total).toFixed(3));
  }
  // Fallback: use lifetime win rate as proxy
  const wr = stats.winrate ?? stats.win_rate ?? stats.winRate;
  return Number.isFinite(wr) ? Number(wr.toFixed(3)) : 0;
}

/**
 * Canonical quality gate. Returns a structured result so callers can log WHY
 * a wallet was rejected rather than just "false".
 *
 * @param {object} stats — normalised wallet stats (see below for field names)
 * @param {object} [cfg] — override FILTER_DEFAULTS
 * @returns {{
 *   passes: boolean,
 *   score: number,           // 0-100 composite quality score
 *   failures: string[],      // which criteria failed
 *   metrics: object,         // computed values for logging
 * }}
 *
 * stats fields consumed (all optional with safe defaults):
 *   winrate / win_rate / winRate  — lifetime win rate (0–1)
 *   completed_trades / tradeCount — total completed trade count
 *   profit_factor                 — pre-computed; or use total_win_sol + total_loss_sol
 *   total_win_sol                 — sum of positive PnLs (SOL)
 *   total_loss_sol                — abs sum of negative PnLs (SOL)
 *   wins                         — win count (for consistency)
 */
export function passesSmartMoneyFilter(stats = {}, cfg = {}) {
  const limits = { ...FILTER_DEFAULTS, ...cfg };
  const failures = [];

  // ── Win rate ─────────────────────────────────────────────────────────────
  const wr = stats.winrate ?? stats.win_rate ?? stats.winRate ?? 0;
  if (wr < limits.minWinRate) {
    failures.push(`win_rate ${(wr * 100).toFixed(1)}% < ${(limits.minWinRate * 100).toFixed(0)}%`);
  }

  // ── Total trades ─────────────────────────────────────────────────────────
  const trades = stats.completed_trades ?? stats.tradeCount ?? stats.trade_count ?? 0;
  if (trades < limits.minTrades) {
    failures.push(`trades ${trades} < ${limits.minTrades}`);
  }

  // ── Profit factor (skip if unavailable) ─────────────────────────────────
  let pf = stats.profit_factor ?? stats.profitFactor ?? null;
  if (pf === 0) pf = null; // 0 is sentinel for "not computed"
  if (pf === null && Number.isFinite(stats.total_win_sol) && Number.isFinite(stats.total_loss_sol)) {
    pf = computeProfitFactor(stats.total_win_sol, stats.total_loss_sol);
  }
  if (pf !== null && Number.isFinite(pf) && pf !== Infinity) {
    if (pf < limits.minProfitFactor) {
      failures.push(`profit_factor ${pf.toFixed(2)} < ${limits.minProfitFactor}`);
    }
  }
  // If pf is null/Infinity/unavailable, skip criterion (don't penalise)

  // ── Consistency score ────────────────────────────────────────────────────
  const consistency = computeConsistencyScore(stats);
  if (consistency < limits.minConsistency) {
    failures.push(`consistency ${(consistency * 100).toFixed(1)}% < ${(limits.minConsistency * 100).toFixed(0)}%`);
  }

  const passes = failures.length === 0;

  // ── Composite score 0–100 ────────────────────────────────────────────────
  const score = scoreSmartMoneyQuality(stats, { wr, trades, pf, consistency, limits });

  return {
    passes,
    score,
    failures,
    metrics: {
      win_rate: Number((wr * 100).toFixed(1)),
      trades,
      profit_factor: pf !== null ? Number(pf.toFixed(2)) : null,
      consistency: Number((consistency * 100).toFixed(1)),
    },
  };
}

/**
 * Composite quality score (0–100). Higher = stronger copy-trade signal.
 * Can be used to rank wallets that all pass the filter.
 *
 * Weights:
 *   35% win rate (normalised against minWinRate→perfect at 90%)
 *   25% trade count (normalised against minTrades→capped at 5×)
 *   25% profit factor (normalised against minPF→capped at 3×)
 *   15% consistency (normalised against minConsistency→perfect at 90%)
 *
 * @param {object} stats
 * @param {object} [_internals] — pre-computed values from passesSmartMoneyFilter
 * @returns {number} 0–100
 */
export function scoreSmartMoneyQuality(stats = {}, _internals = {}) {
  const limits = { ...FILTER_DEFAULTS, ...(_internals.limits || {}) };

  const wr = _internals.wr ?? stats.winrate ?? stats.win_rate ?? stats.winRate ?? 0;
  const trades = _internals.trades ?? stats.completed_trades ?? stats.tradeCount ?? 0;
  let pf = _internals.pf;
  if (pf === undefined) {
    pf = stats.profit_factor ?? stats.profitFactor ?? null;
    if (pf === 0) pf = null;
  }
  const consistency = _internals.consistency ?? computeConsistencyScore(stats);

  // Win rate component: 0 at min, 100 at 90% WR
  const wrScore = Math.min(100, Math.max(0,
    ((wr - limits.minWinRate) / (0.90 - limits.minWinRate)) * 100
  ));

  // Trade count component: 0 at minTrades, 100 at 5× minTrades
  const tradeScore = Math.min(100, Math.max(0,
    ((trades - limits.minTrades) / (4 * limits.minTrades)) * 100
  ));

  // Profit factor component: 0 at minPF, 100 at 3× minPF
  const pfScore = (pf !== null && Number.isFinite(pf) && pf !== Infinity)
    ? Math.min(100, Math.max(0,
        ((pf - limits.minProfitFactor) / (2 * limits.minProfitFactor)) * 100
      ))
    : 50; // neutral when unavailable

  // Consistency component: 0 at min, 100 at 90%
  const conScore = Math.min(100, Math.max(0,
    ((consistency - limits.minConsistency) / (0.90 - limits.minConsistency)) * 100
  ));

  const weighted = wrScore * 0.35 + tradeScore * 0.25 + pfScore * 0.25 + conScore * 0.15;
  return Math.round(weighted);
}
