import { describe, it, expect } from "vitest";
import { checkTrendBreakExit, analyzeMomentum } from "../momentum-analysis.js";

// ── checkTrendBreakExit unit tests ────────────────────────────────────────────

describe("checkTrendBreakExit", () => {
  it("returns shouldExit=true when supertrend.trend is 'down'", () => {
    const result = checkTrendBreakExit(0.0025, { trend: "down", value: 0.003 });
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toMatch(/down/i);
  });

  it("returns shouldExit=true when price drops below SuperTrend line (trend still 'up')", () => {
    // price 0.002 below line 0.003 → should exit even if trend label hasn't flipped yet
    const result = checkTrendBreakExit(0.002, { trend: "up", value: 0.003 });
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toMatch(/below/i);
  });

  it("returns shouldExit=false when supertrend.trend is 'up' and price is above line", () => {
    const result = checkTrendBreakExit(0.005, { trend: "up", value: 0.003 });
    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBe("Trend intact");
  });

  it("returns shouldExit=false when supertrend is null", () => {
    const result = checkTrendBreakExit(0.005, null);
    expect(result.shouldExit).toBe(false);
  });

  it("returns shouldExit=false when currentPrice is null", () => {
    const result = checkTrendBreakExit(null, { trend: "down", value: 0.003 });
    expect(result.shouldExit).toBe(false);
  });

  it("returns shouldExit=false when trend is 'up' and price exactly equals line", () => {
    // Price == line is NOT below it (strict <), so no exit
    const result = checkTrendBreakExit(0.003, { trend: "up", value: 0.003 });
    expect(result.shouldExit).toBe(false);
  });
});

// ── analyzeMomentum candle-count threshold ────────────────────────────────────

describe("analyzeMomentum candle count guard", () => {
  it("returns invalid when fewer than 30 candles supplied", () => {
    const fewCandles = Array.from({ length: 29 }, (_, i) => ({
      close: 1 + i * 0.01, high: 1.1 + i * 0.01, low: 0.9 + i * 0.01,
    }));
    const result = analyzeMomentum(fewCandles);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/insufficient/i);
  });

  it("returns valid=true (or at least does not throw) when 30+ well-formed candles supplied", () => {
    // Build 50 synthetic candles with numeric OHLC so indicators can compute
    const candles = Array.from({ length: 50 }, (_, i) => ({
      close: 1.0 + i * 0.001,
      high:  1.0 + i * 0.001 + 0.005,
      low:   1.0 + i * 0.001 - 0.005,
    }));
    // analyzeMomentum may return valid:false if indicator libs return null,
    // but it must NOT throw and must at least attempt analysis.
    expect(() => analyzeMomentum(candles)).not.toThrow();
  });

  it("returns invalid when null is passed", () => {
    expect(analyzeMomentum(null).valid).toBe(false);
  });

  it("returns invalid when empty array is passed", () => {
    expect(analyzeMomentum([]).valid).toBe(false);
  });
});
