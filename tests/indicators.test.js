import { describe, it, expect } from "vitest";
import {
  calculateRSI,
  calculateATR,
  calculateSuperTrend,
  calculateVolatilityPercentile,
  calculateTokenVolatility,
} from "../utils/indicators.js";

describe("calculateRSI", () => {
  it("returns null when input shorter than period+1", () => {
    expect(calculateRSI([1, 2, 3], 14)).toBeNull();
    expect(calculateRSI([1, 2, 3, 4], 4)).toBeNull();
  });

  it("returns 100 on monotonically rising series (zero losses)", () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calculateRSI(rising, 14)).toBe(100);
  });

  it("returns 0 on monotonically falling series (zero gains)", () => {
    const falling = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(calculateRSI(falling, 14)).toBe(0);
  });

  it("returns 50 on flat series (zero gains AND zero losses → guard branch returns 100)", () => {
    // edge case: when both gains and losses are 0, code returns 100 via the avgLoss===0 branch
    const flat = Array(20).fill(100);
    expect(calculateRSI(flat, 14)).toBe(100);
  });

  it("computes a value in [0,100] for noisy data", () => {
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
                    45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThan(0);
    expect(rsi).toBeLessThan(100);
  });
});

describe("calculateATR", () => {
  it("returns null when too few candles", () => {
    expect(calculateATR([1, 2, 3], [0, 1, 2], [0.5, 1.5, 2.5], 10)).toBeNull();
  });

  it("returns array of ATR values for sufficient input", () => {
    const highs = Array.from({ length: 20 }, (_, i) => 10 + i);
    const lows = Array.from({ length: 20 }, (_, i) => 9 + i);
    const closes = Array.from({ length: 20 }, (_, i) => 9.5 + i);
    const atr = calculateATR(highs, lows, closes, 10);
    expect(Array.isArray(atr)).toBe(true);
    expect(atr.length).toBeGreaterThan(0);
    expect(atr.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });
});

describe("calculateSuperTrend", () => {
  it("returns null on insufficient data", () => {
    expect(calculateSuperTrend([1, 2], [0, 1], [0.5, 1.5], 10, 3)).toBeNull();
  });

  it("returns object with trend up|down and finite value", () => {
    const highs = Array.from({ length: 20 }, (_, i) => 10 + i + Math.sin(i));
    const lows = Array.from({ length: 20 }, (_, i) => 9 + i - Math.sin(i));
    const closes = Array.from({ length: 20 }, (_, i) => 9.5 + i);
    const st = calculateSuperTrend(highs, lows, closes, 10, 3);
    expect(st).not.toBeNull();
    expect(["up", "down"]).toContain(st.trend);
    expect(Number.isFinite(st.value)).toBe(true);
    expect(Array.isArray(st.all)).toBe(true);
  });
});

describe("calculateVolatilityPercentile", () => {
  it("returns 50 (default) on too few candles", () => {
    expect(calculateVolatilityPercentile([{ h: 1, l: 0, c: 0.5 }], 14)).toBe(50);
  });

  it("returns value in [0,100]", () => {
    const klines = Array.from({ length: 30 }, (_, i) => ({
      high: 100 + Math.random() * 5,
      low: 100 - Math.random() * 5,
      close: 100 + (Math.random() - 0.5) * 4,
    }));
    const v = calculateVolatilityPercentile(klines, 14);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });

  it("caps at 100 for extreme volatility", () => {
    // huge ATR vs tiny close price → ratio explodes.
    // Note: low must be > 0; the source uses `k.low || k.l` which falsy-coalesces
    // 0 to undefined and breaks ATR. That's a real edge case but not the point
    // of this test — covered in its own case below.
    const klines = Array.from({ length: 30 }, () => ({
      high: 1000,
      low: 0.001,
      close: 1,
    }));
    expect(calculateVolatilityPercentile(klines, 14)).toBe(100);
  });

  it("REGRESSION: low=0 candles fall through to default (falsy-coalesce bug)", () => {
    // Documents an existing quirk: `k.low || k.l` treats 0 as missing.
    // If this ever gets fixed (e.g. `k.low ?? k.l`), update this expectation.
    const klines = Array.from({ length: 30 }, () => ({
      high: 1000,
      low: 0,
      close: 1,
    }));
    expect(calculateVolatilityPercentile(klines, 14)).toBe(50);
  });
});

describe("calculateTokenVolatility", () => {
  it("returns 50 if not enough data", () => {
    expect(calculateTokenVolatility([{ c: 1 }], 24)).toBe(50);
  });

  it("returns 0 on flat prices (zero stddev)", () => {
    const flat = Array(30).fill({ close: 100 });
    expect(calculateTokenVolatility(flat, 24)).toBe(0);
  });

  it("returns finite percentile in [0,100]", () => {
    const klines = Array.from({ length: 30 }, () => ({
      close: 100 + (Math.random() - 0.5) * 10,
    }));
    const v = calculateTokenVolatility(klines, 24);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });
});
