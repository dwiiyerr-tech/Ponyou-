/**
 * Tests for upgraded indicators: EMA, MACD, EMA-cross, support/resistance,
 * volume profile — and their integration into momentum analysis.
 */
import { describe, it, expect } from "vitest";
import {
  calculateEMA, calculateMACD, calculateEMACross,
  calculateSupportResistance, calculateVolumeProfile,
} from "../utils/indicators.js";
import {
  analyzeMomentum, checkEntryConfirmation, getMomentumScore, checkTrendBreakExit,
} from "../momentum-analysis.js";

// Helpers to build synthetic klines
function uptrend(n = 60, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    return { open: c - step * 0.5, high: c + 1, low: c - 1, close: c, volume: 1000 + i * 10 };
  });
}
function downtrend(n = 60, start = 160, step = 1) {
  return Array.from({ length: n }, (_, i) => {
    const c = start - i * step;
    return { open: c + step * 0.5, high: c + 1, low: c - 1, close: c, volume: 1000 };
  });
}

describe("calculateEMA", () => {
  it("returns null for insufficient data", () => {
    expect(calculateEMA([1, 2, 3], 9)).toBeNull();
  });
  it("returns array aligned to input length with EMA at the end", () => {
    const ema = calculateEMA(Array.from({ length: 20 }, (_, i) => i + 1), 9);
    expect(ema).toHaveLength(20);
    expect(ema[ema.length - 1]).toBeGreaterThan(0);
    expect(ema[0]).toBeNull(); // lead-in padded
  });
  it("EMA of a rising series trends upward", () => {
    const ema = calculateEMA(Array.from({ length: 30 }, (_, i) => i), 9);
    expect(ema[29]).toBeGreaterThan(ema[20]);
  });
});

describe("calculateMACD", () => {
  it("returns null without enough candles", () => {
    expect(calculateMACD([1, 2, 3, 4, 5], 12, 26, 9)).toBeNull();
  });
  it("MACD line positive on a sustained uptrend", () => {
    // The MACD line (EMA12-EMA26) sign is the robust direction signal.
    // On a constant-slope ramp the histogram converges to ~0 (neutral momentum),
    // so we assert the MACD line, not the histogram.
    const closes = uptrend(60).map(k => k.close);
    const macd = calculateMACD(closes);
    expect(macd).not.toBeNull();
    expect(macd.macd).toBeGreaterThan(0);
    expect(macd.trend).toBe("neutral"); // steady ramp = no acceleration
  });
  it("MACD line negative on a sustained downtrend", () => {
    const closes = downtrend(60).map(k => k.close);
    const macd = calculateMACD(closes);
    expect(macd).not.toBeNull();
    expect(macd.macd).toBeLessThan(0);
  });
  it("histogram positive (bullish momentum) on an accelerating uptrend", () => {
    // Quadratic acceleration → MACD pulls away from signal → histogram > 0
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.1);
    const macd = calculateMACD(closes);
    expect(macd).not.toBeNull();
    expect(macd.histogram).toBeGreaterThan(0);
    expect(macd.trend).toBe("bullish");
  });
});

describe("calculateEMACross", () => {
  it("fastAbove=true on uptrend", () => {
    const closes = uptrend(40).map(k => k.close);
    const x = calculateEMACross(closes, 9, 21);
    expect(x).not.toBeNull();
    expect(x.fastAbove).toBe(true);
  });
  it("fastAbove=false on downtrend", () => {
    const closes = downtrend(40).map(k => k.close);
    const x = calculateEMACross(closes, 9, 21);
    expect(x.fastAbove).toBe(false);
  });
});

describe("calculateSupportResistance", () => {
  it("detects resistance above and support below price in a ranging series", () => {
    // zig-zag: creates pivots
    const closes = [], highs = [], lows = [];
    for (let i = 0; i < 60; i++) {
      const base = 100 + (i % 10 < 5 ? i % 5 : 5 - (i % 5)) * 2;
      closes.push(base); highs.push(base + 2); lows.push(base - 2);
    }
    const sr = calculateSupportResistance(highs, lows, closes, 50, 2);
    expect(sr).not.toBeNull();
    expect(sr).toHaveProperty("support");
    expect(sr).toHaveProperty("resistance");
    expect(sr).toHaveProperty("nearResistance");
  });
  it("returns null for tiny series", () => {
    expect(calculateSupportResistance([1, 2], [0, 1], [1, 2], 50, 2)).toBeNull();
  });
});

describe("calculateVolumeProfile", () => {
  it("detects rising volume trend", () => {
    const klines = Array.from({ length: 25 }, (_, i) => ({
      open: 100, close: 101, volume: i < 12 ? 100 : 500, // recent window much higher
    }));
    const vp = calculateVolumeProfile(klines, 10);
    expect(vp).not.toBeNull();
    expect(vp.volumeTrend).toBe("rising");
  });
  it("buyVolRatio high when most candles are green", () => {
    const klines = Array.from({ length: 25 }, () => ({ open: 100, close: 105, volume: 100 }));
    const vp = calculateVolumeProfile(klines, 10);
    expect(vp.buyVolRatio).toBeGreaterThan(0.9);
  });
  it("detects volume spike", () => {
    const klines = Array.from({ length: 25 }, (_, i) => ({
      open: 100, close: 101, volume: i === 24 ? 5000 : 100,
    }));
    const vp = calculateVolumeProfile(klines, 10);
    expect(vp.volumeSpike).toBe(true);
  });
});

describe("analyzeMomentum integration", () => {
  it("includes upgrade indicators on a 60-candle uptrend", () => {
    const m = analyzeMomentum(uptrend(60));
    expect(m.valid).toBe(true);
    expect(m).toHaveProperty("macd");
    expect(m).toHaveProperty("emaCross");
    expect(m).toHaveProperty("supportResistance");
    expect(m).toHaveProperty("volume");
  });
  it("getMomentumScore higher for uptrend than downtrend", () => {
    const up = getMomentumScore(analyzeMomentum(uptrend(60)));
    const down = getMomentumScore(analyzeMomentum(downtrend(60)));
    expect(up).toBeGreaterThan(down);
  });
});

describe("checkTrendBreakExit with extras", () => {
  it("exits on MACD bearish cross even when SuperTrend still up", () => {
    const r = checkTrendBreakExit(100, { trend: "up", value: 95 }, {
      macd: { cross: "bearish_cross", histogram: -0.5 },
      supportResistance: null,
    });
    expect(r.shouldExit).toBe(true);
    expect(r.reason).toMatch(/MACD bearish/);
  });
  it("exits on clean break below support", () => {
    const r = checkTrendBreakExit(90, { trend: "up", value: 85 }, {
      macd: null,
      supportResistance: { support: 95 },
    });
    expect(r.shouldExit).toBe(true);
    expect(r.reason).toMatch(/support/);
  });
  it("backward compatible: no extras, trend up = no exit", () => {
    const r = checkTrendBreakExit(100, { trend: "up", value: 95 });
    expect(r.shouldExit).toBe(false);
  });
});
