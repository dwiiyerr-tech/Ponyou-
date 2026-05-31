/**
 * Backtest rigor coverage — the realistic-cost model, metrics, walk-forward
 * split, and the scorecard that gates strategy-skill promotion. Asserts the
 * scorecard shape matches what strategy-skills.scorecardPasses reads.
 */

import { describe, it, expect } from "vitest";
import {
  simulateTrade,
  backtest,
  priceSeq,
  roundtripCostPct,
  computeMetrics,
  metricsByRegime,
  walkForward,
  buildScorecard,
  DEFAULT_COST_MODEL,
} from "../backtest.js";
import { normalizeCandles } from "../backtest-data/loader.js";
import { scorecardPasses } from "../strategy-skills.js";

// A winning sequence (ramps +50%) and a losing one (drops to stop loss).
const WIN = priceSeq([1.0, 1.2, 1.5, 1.5]);
const LOSS = priceSeq([1.0, 0.9, 0.8, 0.8]);

describe("backtest: realistic cost model", () => {
  it("roundtripCostPct charges slippage+fee on both sides plus partial-fill drag", () => {
    expect(roundtripCostPct({ slippageBps: 150, feeBps: 100, partialFillHaircutPct: 0.3 }))
      .toBeCloseTo(2 * (150 + 100) / 100 + 0.3, 6); // = 5.3%
    expect(roundtripCostPct({})).toBe(0);
  });

  it("applies the haircut to net pnl without touching gross (default = no cost)", () => {
    const gross = simulateTrade({ priceSequence: WIN });
    expect(gross.costPct).toBe(0);
    expect(gross.pnlPct).toBeCloseTo(gross.grossPnlPct, 6);

    const net = simulateTrade({ priceSequence: WIN, costModel: DEFAULT_COST_MODEL });
    expect(net.costPct).toBeCloseTo(5.3, 6);
    expect(net.pnlPct).toBeCloseTo(net.grossPnlPct - 5.3, 6);
    expect(net.grossPnlPct).toBe(gross.grossPnlPct); // gross unchanged
  });
});

describe("backtest: metrics", () => {
  it("computeMetrics returns the keys scorecardPasses reads, with sane values", () => {
    const sim = backtest({ trades: [{ priceSequence: WIN }, { priceSequence: LOSS }] });
    const m = computeMetrics(sim.trades);
    for (const k of ["sample", "win_rate", "expectancy_pct", "max_drawdown_pct", "sharpe"]) {
      expect(m).toHaveProperty(k);
    }
    expect(m.sample).toBe(2);
    expect(m.win_rate).toBe(0.5);
  });

  it("metricsByRegime buckets by the trade's marketCondition", () => {
    const sim = backtest({ trades: [
      { priceSequence: WIN, marketCondition: "HOT" },
      { priceSequence: LOSS, marketCondition: "COLD" },
    ] });
    const byReg = metricsByRegime(sim.trades);
    expect(byReg.HOT.n).toBe(1);
    expect(byReg.COLD.n).toBe(1);
  });
});

describe("backtest: walk-forward + entry gate", () => {
  it("splits results into in-sample / out-of-sample by ratio", () => {
    const trades = Array.from({ length: 10 }, () => ({ priceSequence: WIN }));
    const wf = walkForward({ trades, splitRatio: 0.7 });
    expect(wf.in_sample.sample).toBe(7);
    expect(wf.out_of_sample.sample).toBe(3);
  });

  it("entryGate excludes rejected candidates and reports entrySkipped", () => {
    const trades = [
      { priceSequence: WIN, entryFeatures: { mcap: 5000 } },
      { priceSequence: LOSS, entryFeatures: { mcap: 999999 } },
    ];
    const sim = backtest({ trades, entryGate: (f) => f.mcap < 100000 });
    expect(sim.total).toBe(1);
    expect(sim.entrySkipped).toBe(1);
  });
});

describe("backtest: scorecard ↔ registry gate", () => {
  it("buildScorecard emits the shape scorecardPasses consumes", () => {
    // 12 winners so out-of-sample clears the gate thresholds.
    const trades = Array.from({ length: 12 }, () => ({ priceSequence: WIN }));
    const card = buildScorecard({ trades, splitRatio: 0.5 });
    expect(card.cost_model.roundtrip_cost_pct).toBeCloseTo(5.3, 6);
    expect(card.walk_forward.out_of_sample).toHaveProperty("expectancy_pct");
    expect(card.by_regime).toBeTruthy();
    // The registry gate must be able to read this card.
    const gate = scorecardPasses(card);
    expect(typeof gate.passed).toBe("boolean");
    expect(card.metrics.sample).toBe(12);
  });
});

describe("backtest-data loader: candle normalization", () => {
  it("normalizes GeckoTerminal {candles:[{time,close}]} (sec→ms, sorted)", () => {
    const seq = normalizeCandles({ candles: [
      { time: 200, close: 1.2 }, { time: 100, close: 1.0 },
    ] });
    expect(seq).toEqual([{ ts: 100000, price: 1.0 }, { ts: 200000, price: 1.2 }]);
  });
  it("normalizes array-of-arrays [ts,o,h,l,c,v] and drops bad rows", () => {
    const seq = normalizeCandles([[1700000000, 1, 2, 0.5, 1.5, 10], [0, 0, 0, 0, 0, 0]]);
    expect(seq).toHaveLength(1);
    expect(seq[0].price).toBe(1.5);
  });
  it("returns [] for unknown shapes", () => {
    expect(normalizeCandles({ nope: true })).toEqual([]);
    expect(normalizeCandles(null)).toEqual([]);
  });
});
