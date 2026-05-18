import { describe, it, expect } from "vitest";
import { simulateTrade, backtest, priceSeq } from "../backtest.js";

describe("simulateTrade — exit logic", () => {
  it("triggers stop-loss when price crashes past the threshold", () => {
    // Enter at 1.0, drop to 0.7 = -30%. Default scalping SL is around -15%,
    // but we override to -15 explicitly for determinism.
    const prices = priceSeq([1.0, 0.95, 0.85, 0.70]);
    const result = simulateTrade({
      priceSequence: prices,
      stopLossPctOverride: -15,
    });
    expect(result.exitReason).toMatch(/Stop Loss/);
    expect(result.pnlPct).toBeLessThan(-10);
    expect(result.isWin).toBe(false);
  });

  it("triggers immediate take-profit at user override", () => {
    const prices = priceSeq([1.0, 1.10, 1.30]);
    const result = simulateTrade({
      priceSequence: prices,
      takeProfitPctOverride: 25, // 25% TP
    });
    expect(result.exitReason).toMatch(/Immediate TP/);
    expect(result.pnlPct).toBeGreaterThan(20);
    expect(result.isWin).toBe(true);
  });

  it("does not exit when price stays flat (forces close at end of data)", () => {
    const prices = priceSeq([1.0, 1.0, 1.0, 1.0]);
    const result = simulateTrade({ priceSequence: prices });
    expect(result.exitReason).toMatch(/End of data/);
    expect(result.pnlPct).toBeCloseTo(0);
  });

  it("captures peak even if it later drops", () => {
    // 1.0 → 1.5 (peak +50%) → 1.2 (now +20%)
    const prices = priceSeq([1.0, 1.2, 1.5, 1.4, 1.2]);
    const result = simulateTrade({ priceSequence: prices });
    expect(result.peakPnlPct).toBeCloseTo(50, 0);
  });

  it("captures peak before exit fires", () => {
    // Note: scalping NORMAL ROI is { 0: 0.40 } so a +50% tick immediately
    // hits the 40% threshold and exits. That's why peak ends at 50%, not
    // higher. The point is just that peak is being tracked correctly.
    const prices = priceSeq([1.0, 1.5, 2.0, 1.7, 1.4]);
    const result = simulateTrade({ priceSequence: prices });
    expect(typeof result.exitReason).toBe("string");
    expect(result.peakPnlPct).toBeGreaterThanOrEqual(50);
    expect(result.pnlPct).toBeGreaterThan(0);
  });

  it("entry-price tick itself does NOT trigger exit", () => {
    // If entry price already qualifies for ROI/SL, the first tick shouldn't fire.
    const prices = priceSeq([1.0, 1.0]); // identical, no movement
    const result = simulateTrade({ priceSequence: prices });
    expect(result.exitReason).toMatch(/End of data/);
  });

  it("throws on too-short price sequence", () => {
    expect(() => simulateTrade({ priceSequence: [{ ts: 0, price: 1 }] })).toThrow();
    expect(() => simulateTrade({ priceSequence: [] })).toThrow();
  });
});

describe("simulateTrade — partial TP behavior", () => {
  // The active scalping preset has partial_tp disabled by default, so we can't
  // directly test the partial path without switching presets. These tests just
  // confirm the no-partial path doesn't blow up.

  it("returns finalSize=1.0 when partial TP disabled", () => {
    const prices = priceSeq([1.0, 1.05, 1.10, 1.0]);
    const result = simulateTrade({ priceSequence: prices });
    expect(result.finalSize).toBe(1.0);
    expect(result.partialTpDone).toBe(false);
  });
});

describe("backtest — aggregation", () => {
  it("returns empty summary for no trades", () => {
    const r = backtest({ trades: [] });
    expect(r.total).toBe(0);
    expect(r.winRate).toBe(0);
  });

  it("computes win rate, avg win/loss, profit factor", () => {
    // 3 winners, 2 losers
    const trades = [
      { priceSequence: priceSeq([1.0, 1.30]) },                 // +30%
      { priceSequence: priceSeq([1.0, 1.20]) },                 // +20%
      { priceSequence: priceSeq([1.0, 1.10]) },                 // +10%
      { priceSequence: priceSeq([1.0, 0.80]), stopLossPctOverride: -15 }, // SL -15%
      { priceSequence: priceSeq([1.0, 0.90]) },                 // -10% (forced close)
    ];
    const r = backtest({ trades, takeProfitPctOverride: 5 }); // exit at first 5%+

    expect(r.total).toBe(5);
    expect(r.wins).toBe(3);
    expect(r.losses).toBe(2);
    expect(r.winRate).toBeCloseTo(0.6);
    expect(r.avgWinPct).toBeGreaterThan(0);
    expect(r.avgLossPct).toBeLessThan(0);
    expect(r.profitFactor).toBeGreaterThan(0);
  });

  it("computes max drawdown on cumulative equity curve", () => {
    // +10%, -20%, +5% → cum: 10, -10, -5. Peak 10, max DD = 20.
    const trades = [
      { priceSequence: priceSeq([1.0, 1.10]), takeProfitPctOverride: 5 }, // +10%
      { priceSequence: priceSeq([1.0, 0.80]), stopLossPctOverride: -15 }, // -15% or worse
      { priceSequence: priceSeq([1.0, 1.05]), takeProfitPctOverride: 4 }, // +~5%
    ];
    const r = backtest({ trades });
    expect(r.maxDrawdownPct).toBeGreaterThan(10);
  });

  it("profitFactor is Infinity when all winners", () => {
    const trades = [
      { priceSequence: priceSeq([1.0, 1.10]), takeProfitPctOverride: 5 },
      { priceSequence: priceSeq([1.0, 1.20]), takeProfitPctOverride: 5 },
    ];
    expect(backtest({ trades }).profitFactor).toBe(Infinity);
  });
});

describe("priceSeq helper", () => {
  it("generates monotone-timestamped ticks", () => {
    const seq = priceSeq([1, 2, 3], 100, 1000);
    expect(seq).toEqual([
      { ts: 1000, price: 1 },
      { ts: 1100, price: 2 },
      { ts: 1200, price: 3 },
    ]);
  });

  it("respects custom interval", () => {
    const seq = priceSeq([1, 1], 60_000);
    expect(seq[1].ts - seq[0].ts).toBe(60_000);
  });
});
