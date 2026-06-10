import { describe, it, expect, beforeEach } from "vitest";
import {
  startTimer,
  elapsedMs,
  recordLatency,
  recordSlippage,
  recordError,
  recordCounter,
  setGauge,
  getStats,
  readPersistedStats,
  flushMetrics,
  _resetForTests,
} from "../metrics.js";

beforeEach(() => {
  _resetForTests();
});

describe("startTimer + elapsedMs", () => {
  it("returns non-negative elapsed time", async () => {
    // Node's setTimeout often fires a hair early (4-5ms when asked for 5ms),
    // so we bound generously: positive value, sane upper limit.
    const t = startTimer();
    await new Promise((r) => setTimeout(r, 20));
    const e = elapsedMs(t);
    expect(e).toBeGreaterThan(0);
    expect(e).toBeLessThan(500);
  });
});

describe("recordLatency", () => {
  it("creates series and computes percentiles", () => {
    for (let i = 1; i <= 100; i++) recordLatency("test", i);
    const stats = getStats();
    const s = stats.series.test_ms;
    expect(s.count).toBe(100);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(51); // floor(0.5 * 100) = 50, index → sorted[50] = 51
    expect(s.p95).toBe(96);
    expect(s.p99).toBe(100);
  });

  it("ignores non-finite values", () => {
    recordLatency("test", NaN);
    recordLatency("test", Infinity);
    recordLatency("test", 100);
    const s = getStats().series.test_ms;
    expect(s.count).toBe(1);
  });

  it("rolls window — keeps only last HISTORY_CAP samples", () => {
    for (let i = 0; i < 250; i++) recordLatency("roll", i);
    const s = getStats().series.roll_ms;
    expect(s.count).toBe(200); // HISTORY_CAP
    expect(s.min).toBe(50); // first 50 dropped
  });
});

describe("recordSlippage", () => {
  it("computes ratio (expected-actual)/expected", () => {
    recordSlippage({ expected_out: 100, actual_out: 95 });
    recordSlippage({ expected_out: 100, actual_out: 90 });
    const s = getStats().series.swap_slippage_ratio;
    expect(s.count).toBe(2);
    expect(s.min).toBeCloseTo(0.05);
    expect(s.max).toBeCloseTo(0.10);
  });

  it("handles negative slippage (positive surprise)", () => {
    recordSlippage({ expected_out: 100, actual_out: 105 });
    const s = getStats().series.swap_slippage_ratio;
    expect(s.min).toBeCloseTo(-0.05);
  });

  it("ignores invalid inputs", () => {
    recordSlippage({ expected_out: 0, actual_out: 5 });
    recordSlippage({ expected_out: -10, actual_out: 5 });
    recordSlippage({ expected_out: NaN, actual_out: 5 });
    expect(getStats().series.swap_slippage_ratio).toBeUndefined();
  });
});

describe("recordError / recordCounter", () => {
  it("increments named counters", () => {
    recordError("helius_429");
    recordError("helius_429");
    recordCounter("swaps", 3);
    const c = getStats().counters;
    expect(c.helius_429).toBe(2);
    expect(c.swaps).toBe(3);
  });
});

describe("setGauge", () => {
  it("stores latest value", () => {
    setGauge("balance_usd", 100);
    setGauge("balance_usd", 95);
    expect(getStats().gauges.balance_usd).toBe(95);
  });

  it("ignores non-finite", () => {
    setGauge("x", NaN);
    expect(getStats().gauges.x).toBeUndefined();
  });
});

describe("readPersistedStats", () => {
  it("reads the latest cross-process metrics snapshot", async () => {
    recordCounter("gmgn_ok", 4);
    setGauge("gmgn_circuit_until", 12345);
    await flushMetrics();

    const persisted = readPersistedStats();
    expect(persisted.counters.gmgn_ok).toBe(4);
    expect(persisted.gauges.gmgn_circuit_until).toBe(12345);
  });
});
