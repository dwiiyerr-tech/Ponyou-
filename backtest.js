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
  getEffectiveStopLoss,
  getEffectiveImmediateTakeProfit,
} from "./strategy.js";

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
} = {}) {
  if (!Array.isArray(priceSequence) || priceSequence.length < 2) {
    throw new Error("priceSequence must be an array of at least 2 ticks");
  }

  const effStopLoss = getEffectiveStopLoss(stopLossPctOverride);
  const effImmediateTP = getEffectiveImmediateTakeProfit(takeProfitPctOverride);

  const entryTick = priceSequence[0];
  const entryTs = entryTick.ts;
  const entryPrice = entryTick.price;

  let peakPnlPct = 0;
  let partialTpDone = false;
  let remainingSize = 1.0; // 1.0 = full position; partial TP reduces this
  let exitTick = null;
  let exitReason = null;
  let realizedPnlPct = 0; // PnL captured from partial TPs so far

  // Start from index 1 — the entry tick itself doesn't trigger exits.
  for (let i = 1; i < priceSequence.length; i++) {
    const tick = priceSequence[i];
    const ageMinutes = (tick.ts - entryTs) / 60_000;
    const currentPnlPct = ((tick.price - entryPrice) / entryPrice) * 100;

    if (currentPnlPct > peakPnlPct) peakPnlPct = currentPnlPct;

    // 1. Stop loss (hard floor)
    if (currentPnlPct / 100 <= effStopLoss) {
      exitTick = tick;
      exitReason = `Stop Loss: ${currentPnlPct.toFixed(2)}% (SL ${(effStopLoss * 100).toFixed(0)}%)`;
      break;
    }

    // 2. Immediate TP (user override)
    if (effImmediateTP != null && currentPnlPct / 100 >= effImmediateTP) {
      exitTick = tick;
      exitReason = `Immediate TP: ${currentPnlPct.toFixed(2)}%`;
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
    const ts = checkTrailingStop(currentPnlPct, peakPnlPct);
    if (ts.exit) {
      exitTick = tick;
      exitReason = ts.reason;
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
  const totalPnlPct = realizedPnlPct + (finalPnlAtExit * remainingSize);

  return {
    entry: { ts: entryTs, price: entryPrice },
    exit: { ts: exitTick.ts, price: exitTick.price },
    holdMinutes: (exitTick.ts - entryTs) / 60_000,
    exitReason,
    pnlPct: totalPnlPct,
    peakPnlPct,
    partialTpDone,
    finalSize: remainingSize,
    isWin: totalPnlPct > 0,
  };
}

/**
 * Run multiple trades and aggregate. Each input trade is `{ priceSequence }`
 * plus optional per-trade overrides.
 *
 * @returns {object} summary — see test fixtures for shape.
 */
export function backtest({ trades = [], marketCondition = "NORMAL", stopLossPctOverride = null, takeProfitPctOverride = null } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, totalPnlPct: 0, trades: [] };
  }

  const results = trades.map((t) =>
    simulateTrade({
      priceSequence: t.priceSequence,
      marketCondition: t.marketCondition ?? marketCondition,
      stopLossPctOverride: t.stopLossPctOverride ?? stopLossPctOverride,
      takeProfitPctOverride: t.takeProfitPctOverride ?? takeProfitPctOverride,
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
