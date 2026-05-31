/**
 * Backtest engine — replays a sequence of price ticks through the existing
 * strategy.js exit logic to compute what would have happened. No new strategy
 * code: this just calls the same checkROI / checkTrailingStop / checkPartialTP
 * / getEffectiveStopLoss the live agent uses, so a green backtest means the
 * live agent will respond identically to the same price sequence.
 *
 * What's NOT modeled:
 *  - entry decision quality (we accept entries as given)
 *  - slippage / gas / partial fills (compounds to ~-1% per trade IRL — apply
 *    a haircut in your reporting if you care)
 *  - market-condition transitions inside a trade (use the condition the trade
 *    was opened in; real bot recomputes per cycle but the effect is small over
 *    minutes-to-hours holds)
 *  - rug events (skipped — the rug-detection layer is independent)
 *
 * Usage:
 *   import { simulateTrade, backtest } from "./backtest.js";
 *
 *   const result = simulateTrade({
 *     priceSequence: [{ ts: 0, price: 1.0 }, { ts: 60_000, price: 1.15 }, ...],
 *     marketCondition: "NORMAL",
 *     stopLossPctOverride: -15,    // optional
 *     takeProfitPctOverride: null, // optional
 *   });
 *
 *   const summary = backtest({ trades: [{ priceSequence: [...] }, ...] });
 */

import {
  checkROI,
  checkTrailingStop,
  checkPartialTP,
} from "./strategy.js";
import { buildRiskPolicy, evaluateExitPolicy } from "./risk-policy.js";

/**
 * Simulate one trade through a price sequence.
 *
 * @param {object} opts
 * @param {Array<{ts:number, price:number}>} opts.priceSequence  Ordered ticks.
 *        ts is anything monotone-increasing (epoch ms recommended).
 * @param {string} [opts.marketCondition="NORMAL"]  ROI table key.
 * @param {number|null} [opts.stopLossPctOverride]  Percent, negative
 *        (e.g. -15 means -15%). Null = use active strategy default.
 * @param {number|null} [opts.takeProfitPctOverride]  Percent, positive.
 *        Null = use ROI table only.
 *
 * @returns {object} trade record — see EXAMPLE_RESULT in tests for shape.
 */
export function simulateTrade({
  priceSequence,
  marketCondition = "NORMAL",
  stopLossPctOverride = null,
  takeProfitPctOverride = null,
  policy = null,
  costModel = null,
} = {}) {
  if (!Array.isArray(priceSequence) || priceSequence.length < 2) {
    throw new Error("priceSequence must be an array of at least 2 ticks");
  }

  const effectivePolicy = policy || buildRiskPolicy({
    marketCondition,
    config: {
      management: {
        stopLossPct: stopLossPctOverride,
        takeProfitPct: takeProfitPctOverride,
      },
    },
  });

  const entryTick = priceSequence[0];
  const entryTs = entryTick.ts;
  const entryPrice = entryTick.price;

  let peakPnlPct = 0;
  let partialTpDone = false;
  let remainingSize = 1.0; // 1.0 = full position; partial TP reduces this
  let exitTick = null;
  let exitReason = null;
  let realizedPnlPct = 0; // PnL captured from partial TPs so far
  let profitSweepEligible = false;

  // Start from index 1 — the entry tick itself doesn't trigger exits.
  for (let i = 1; i < priceSequence.length; i++) {
    const tick = priceSequence[i];
    const ageMinutes = (tick.ts - entryTs) / 60_000;
    const currentPnlPct = ((tick.price - entryPrice) / entryPrice) * 100;

    if (currentPnlPct > peakPnlPct) peakPnlPct = currentPnlPct;

    const exitPolicy = evaluateExitPolicy({
      pnlPct: currentPnlPct,
      peakPnlPct,
      policy: effectivePolicy,
    });
    profitSweepEligible = profitSweepEligible || exitPolicy.profitSweepEligible;

    // 1. Hard emergency exits
    if (exitPolicy.hardCutLoss) {
      exitTick = tick;
      exitReason = exitPolicy.hardCutLossReason;
      break;
    }
    if (exitPolicy.hardStopLoss) {
      exitTick = tick;
      exitReason = exitPolicy.hardStopLossReason;
      break;
    }

    // 2. Immediate TP (user override)
    if (exitPolicy.takeProfit) {
      exitTick = tick;
      exitReason = exitPolicy.takeProfitReason;
      break;
    }

    // 3. Partial TP — keep running, just reduce remaining size
    if (!partialTpDone) {
      const p = checkPartialTP(currentPnlPct, false);
      if (p.trigger) {
        const sellFrac = p.sell_pct / 100;
        realizedPnlPct += (currentPnlPct * sellFrac * remainingSize);
        remainingSize *= (1 - sellFrac);
        partialTpDone = true;
        // Don't exit — partial only sells a fraction.
      }
    }

    // 4. ROI table
    const roi = checkROI(ageMinutes, currentPnlPct, marketCondition);
    if (roi.exit) {
      exitTick = tick;
      exitReason = roi.reason;
      break;
    }

    // 5. Trailing stop
    if (exitPolicy.trailingStop) {
      exitTick = tick;
      exitReason = exitPolicy.trailingStopReason;
      break;
    }
  }

  // If no exit triggered, treat the last tick as a forced close — useful for
  // backtests where the data window ends but the position is still open.
  if (!exitTick) {
    exitTick = priceSequence[priceSequence.length - 1];
    exitReason = "End of data (forced close)";
  }

  const finalPnlAtExit = ((exitTick.price - entryPrice) / entryPrice) * 100;
  // Total trade PnL = realized portion (already locked in via partial TP) +
  // remaining portion sold at final exit price.
  const grossPnlPct = realizedPnlPct + (finalPnlAtExit * remainingSize);

  // Realistic-cost haircut (opt-in). The live agent loses slippage + fees on
  // BOTH the entry and the exit, and partial fills cost extra. A green backtest
  // without this overstates edge — see costModel docs in buildScorecard.
  const costPct = costModel ? roundtripCostPct(costModel) : 0;
  const totalPnlPct = grossPnlPct - costPct;

  return {
    entry: { ts: entryTs, price: entryPrice },
    exit: { ts: exitTick.ts, price: exitTick.price },
    holdMinutes: (exitTick.ts - entryTs) / 60_000,
    exitReason,
    pnlPct: totalPnlPct,
    grossPnlPct,
    costPct,
    peakPnlPct,
    partialTpDone,
    profitSweepEligible,
    finalSize: remainingSize,
    isWin: totalPnlPct > 0,
    marketCondition,
    policy: effectivePolicy,
  };
}

/**
 * Round-trip cost in percentage points for one trade. Slippage + fee are paid
 * on entry AND exit; an unmodeled partial fill adds a configurable haircut.
 *   { slippageBps, feeBps, partialFillHaircutPct }  (all optional; bps = 1/100 %)
 */
export function roundtripCostPct(costModel = {}) {
  const slippageBps = Number(costModel.slippageBps ?? 0);
  const feeBps = Number(costModel.feeBps ?? 0);
  const partialHaircut = Number(costModel.partialFillHaircutPct ?? 0);
  return 2 * (slippageBps + feeBps) / 100 + partialHaircut;
}

// A conservative default cost model for memecoin swaps: ~1.5% slippage + ~1%
// fees per side, ~0.3% partial-fill drag → ~5.3%/trade round-trip. Tune per DEX.
export const DEFAULT_COST_MODEL = { slippageBps: 150, feeBps: 100, partialFillHaircutPct: 0.3 };

/**
 * Run multiple trades and aggregate. Each input trade is `{ priceSequence }`
 * plus optional per-trade overrides.
 *
 * @returns {object} summary — see test fixtures for shape.
 */
export function backtest({ trades = [], marketCondition = "NORMAL", stopLossPctOverride = null, takeProfitPctOverride = null, policy = null, costModel = null, entryGate = null } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, totalPnlPct: 0, trades: [] };
  }

  // Entry-decision replay (opt-in): only take trades the strategy's entry gate
  // would have accepted given the candidate's entry-time features. Without this
  // the backtest assumes perfect entry selection and overstates the strategy.
  const taken = typeof entryGate === "function"
    ? trades.filter((t) => entryGate(t.entryFeatures ?? t.features ?? {}, t))
    : trades;
  const skipped = trades.length - taken.length;

  const results = taken.map((t) =>
    simulateTrade({
      priceSequence: t.priceSequence,
      marketCondition: t.marketCondition ?? marketCondition,
      stopLossPctOverride: t.stopLossPctOverride ?? stopLossPctOverride,
      takeProfitPctOverride: t.takeProfitPctOverride ?? takeProfitPctOverride,
      policy: t.policy ?? policy,
      costModel: t.costModel ?? costModel,
    })
  );

  const wins = results.filter((r) => r.isWin);
  const losses = results.filter((r) => !r.isWin);
  const totalPnlPct = results.reduce((s, r) => s + r.pnlPct, 0);

  const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0;

  // Profit factor = total gains / |total losses|. Infinity when no losses.
  const grossWin = wins.reduce((s, r) => s + r.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // Max drawdown on the equity curve (cumulative pnl over trade order).
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of results) {
    cum += r.pnlPct;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    total: results.length,
    entrySkipped: skipped,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / results.length,
    totalPnlPct,
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    profitFactor,
    maxDrawdownPct: maxDd,
    trades: results,
  };
}

/**
 * Build a price sequence from a flat array of prices using a fixed tick interval.
 * Useful for quick tests and synthetic scenarios.
 */
export function priceSeq(prices, tickMs = 60_000, startTs = 0) {
  return prices.map((price, i) => ({ ts: startTs + i * tickMs, price }));
}

// ─── Rigor: metrics, walk-forward, scorecard ──────────────────

/**
 * Per-trade performance metrics for an array of simulated trade results
 * (output of simulateTrade). Keys match what strategy-skills.scorecardPasses
 * reads: { sample, win_rate, expectancy_pct, max_drawdown_pct, sharpe, ... }.
 */
export function computeMetrics(results = []) {
  const n = results.length;
  if (n === 0) {
    return { sample: 0, win_rate: 0, expectancy_pct: 0, max_drawdown_pct: 0, sharpe: 0, total_return_pct: 0, profit_factor: 0, avg_win_pct: 0, avg_loss_pct: 0 };
  }
  const pnls = results.map((r) => r.pnlPct);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const total = pnls.reduce((s, p) => s + p, 0);
  const mean = total / n;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  // Per-trade Sharpe (not annualized) — relative comparison across skills.
  const sharpe = std > 0 ? mean / std : (mean > 0 ? Infinity : 0);
  const grossWin = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));

  let cum = 0, peak = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    sample: n,
    win_rate: wins.length / n,
    expectancy_pct: mean,
    total_return_pct: total,
    max_drawdown_pct: maxDd,
    sharpe: Number.isFinite(sharpe) ? sharpe : 999,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avg_win_pct: wins.length ? grossWin / wins.length : 0,
    avg_loss_pct: losses.length ? -grossLoss / losses.length : 0,
  };
}

/** Group metrics by the marketCondition each trade was simulated in. */
export function metricsByRegime(results = []) {
  const buckets = {};
  for (const r of results) {
    const k = r.marketCondition || "NORMAL";
    (buckets[k] ||= []).push(r);
  }
  const out = {};
  for (const [k, rs] of Object.entries(buckets)) {
    const m = computeMetrics(rs);
    out[k] = { n: m.sample, win_rate: m.win_rate, expectancy_pct: m.expectancy_pct };
  }
  return out;
}

/**
 * Walk-forward split: simulate all trades, then split the RESULTS in time order
 * into in-sample / out-of-sample by ratio, and report metrics for each. Promotion
 * is judged on the out-of-sample slice (held-out), which resists overfitting.
 */
export function walkForward({ trades = [], splitRatio = 0.7, ...rest } = {}) {
  const sim = backtest({ trades, ...rest });
  const results = sim.trades;
  const cut = Math.floor(results.length * splitRatio);
  return {
    in_sample: computeMetrics(results.slice(0, cut)),
    out_of_sample: computeMetrics(results.slice(cut)),
  };
}

/**
 * Build the standard backtest_scorecard consumed by the strategy-skill registry
 * (strategy-skills.js scorecardPasses). Applies a realistic cost model by default.
 *
 * @param {object} opts
 * @param {Array}  opts.trades        backtest trades ({ priceSequence, marketCondition?, ... })
 * @param {object} [opts.costModel]   slippage/fee/partial-fill model (DEFAULT_COST_MODEL)
 * @param {number} [opts.splitRatio]  in-sample fraction for walk-forward (0.7)
 * @param {function} [opts.entryGate] optional entry-decision filter
 */
export function buildScorecard({ trades = [], costModel = DEFAULT_COST_MODEL, splitRatio = 0.7, entryGate = null, marketCondition = "NORMAL", policy = null } = {}) {
  const sim = backtest({ trades, costModel, entryGate, marketCondition, policy });
  const metrics = computeMetrics(sim.trades);
  const wf = walkForward({ trades, costModel, entryGate, marketCondition, policy, splitRatio });
  return {
    generated_at: new Date().toISOString(),
    sample: metrics.sample,
    entry_skipped: sim.entrySkipped || 0,
    cost_model: {
      slippage_bps: costModel?.slippageBps ?? 0,
      fee_bps: costModel?.feeBps ?? 0,
      partial_fill_haircut_pct: costModel?.partialFillHaircutPct ?? 0,
      roundtrip_cost_pct: roundtripCostPct(costModel || {}),
    },
    metrics,
    by_regime: metricsByRegime(sim.trades),
    walk_forward: { in_sample: wf.in_sample, out_of_sample: wf.out_of_sample },
  };
}
