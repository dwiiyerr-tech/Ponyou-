import { describe, it, expect } from "vitest";
import { checkRiskReward, RR_DEFAULTS } from "../rr-guard.js";

// ─── RR_DEFAULTS ──────────────────────────────────────────────────────────────

describe("RR_DEFAULTS", () => {
  it("has correct default minRatio", () => {
    expect(RR_DEFAULTS.minRatio).toBe(1.5);
  });
});

// ─── checkRiskReward — passing cases ─────────────────────────────────────────

describe("checkRiskReward — passes", () => {
  it("passes when ratio exactly meets minRatio", () => {
    // SL=-10, TP=15 → ratio=1.5
    const r = checkRiskReward(-10, 15);
    expect(r.passes).toBe(true);
    expect(r.ratio).toBeCloseTo(1.5, 1);
  });

  it("passes when ratio exceeds minRatio", () => {
    // SL=-12, TP=30 → ratio=2.5
    const r = checkRiskReward(-12, 30);
    expect(r.passes).toBe(true);
    expect(r.ratio).toBeCloseTo(2.5, 1);
  });

  it("passes with custom minRatio", () => {
    // SL=-10, TP=20 → ratio=2.0 >= minRatio=2.0
    const r = checkRiskReward(-10, 20, { minRatio: 2.0 });
    expect(r.passes).toBe(true);
  });

  it("uses trailingTriggerPct as proxy when tpPct is null and passes", () => {
    // SL=-10, trailing=20 → ratio=2.0 ≥ 1.5
    const r = checkRiskReward(-10, null, { trailingTriggerPct: 20 });
    expect(r.passes).toBe(true);
    expect(r.tp).toBe(20);
    expect(r.ratio).toBeCloseTo(2.0, 1);
  });

  it("uses trailingTriggerPct when tpPct is 0 (treated as absent)", () => {
    const r = checkRiskReward(-10, 0, { trailingTriggerPct: 20 });
    expect(r.passes).toBe(true);
    expect(r.tp).toBe(20);
  });

  it("uses trailingTriggerPct when tpPct is undefined", () => {
    const r = checkRiskReward(-10, undefined, { trailingTriggerPct: 20 });
    expect(r.passes).toBe(true);
  });

  it("skips check (passes=true) when no TP and no trailing", () => {
    const r = checkRiskReward(-10, null);
    expect(r.passes).toBe(true);
    expect(r.ratio).toBeNull();
    expect(r.reason).toBe("tp_unknown_skip");
  });

  it("skips check when trailingTriggerPct is null", () => {
    const r = checkRiskReward(-10, null, { trailingTriggerPct: null });
    expect(r.passes).toBe(true);
    expect(r.reason).toBe("tp_unknown_skip");
  });

  it("skips check (passes=true) when slPct is invalid (positive number)", () => {
    const r = checkRiskReward(5, 30);
    expect(r.passes).toBe(true);
    expect(r.reason).toBe("sl_invalid_skip");
  });

  it("skips check when slPct is 0", () => {
    const r = checkRiskReward(0, 30);
    expect(r.passes).toBe(true);
    expect(r.reason).toBe("sl_invalid_skip");
  });

  it("skips check when slPct is NaN", () => {
    const r = checkRiskReward(NaN, 30);
    expect(r.passes).toBe(true);
    expect(r.reason).toBe("sl_invalid_skip");
  });

  it("skips check when slPct is null", () => {
    const r = checkRiskReward(null, 30);
    expect(r.passes).toBe(true);
    expect(r.reason).toBe("sl_invalid_skip");
  });
});

// ─── checkRiskReward — failing cases ─────────────────────────────────────────

describe("checkRiskReward — fails", () => {
  it("fails when ratio is below minRatio", () => {
    // SL=-20, TP=20 → ratio=1.0 < 1.5
    const r = checkRiskReward(-20, 20);
    expect(r.passes).toBe(false);
    expect(r.ratio).toBeCloseTo(1.0, 1);
    expect(r.reason).toMatch(/R:R/);
    expect(r.reason).toMatch(/< 1.5/);
  });

  it("fails with tight SL and small TP", () => {
    // SL=-10, TP=10 → ratio=1.0 < 1.5
    const r = checkRiskReward(-10, 10);
    expect(r.passes).toBe(false);
  });

  it("fails when trailing proxy gives insufficient ratio", () => {
    // SL=-20, trailing=15 → ratio=0.75 < 1.5
    const r = checkRiskReward(-20, null, { trailingTriggerPct: 15 });
    expect(r.passes).toBe(false);
    expect(r.tp).toBe(15);
    expect(r.ratio).toBeCloseTo(0.75, 2);
  });

  it("respects custom minRatio when rejecting", () => {
    // SL=-10, TP=25 → ratio=2.5 — passes 1.5 default but fails custom 3.0
    const r = checkRiskReward(-10, 25, { minRatio: 3.0 });
    expect(r.passes).toBe(false);
    expect(r.reason).toMatch(/< 3/);
  });

  it("reason string includes SL and TP values", () => {
    const r = checkRiskReward(-15, 10);
    expect(r.reason).toContain("SL=-15%");
    expect(r.reason).toContain("TP=10%");
  });
});

// ─── checkRiskReward — return shape ──────────────────────────────────────────

describe("checkRiskReward — return shape", () => {
  it("returns sl and tp in result for passing case", () => {
    const r = checkRiskReward(-12, 30);
    expect(r.sl).toBe(-12);
    expect(r.tp).toBe(30);
  });

  it("returns sl and tp in result for failing case", () => {
    const r = checkRiskReward(-20, 10);
    expect(r.sl).toBe(-20);
    expect(r.tp).toBe(10);
  });

  it("ratio is rounded to 2 decimal places", () => {
    // SL=-7, TP=10 → ratio=1.4285... → 1.43
    const r = checkRiskReward(-7, 10);
    expect(r.ratio).toBe(1.43);
  });

  it("passing result has no reason field", () => {
    const r = checkRiskReward(-10, 20);
    expect(r.reason).toBeUndefined();
  });

  it("failing result always has reason field", () => {
    const r = checkRiskReward(-20, 10);
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

// ─── edge cases ──────────────────────────────────────────────────────────────

describe("checkRiskReward — edge cases", () => {
  it("handles very tight SL (e.g. -3 DEAD market)", () => {
    // SL=-3, TP=5 → ratio=1.67 ≥ 1.5
    const r = checkRiskReward(-3, 5);
    expect(r.passes).toBe(true);
  });

  it("handles large SL typical of degen strategy", () => {
    // SL=-30, TP=50 → ratio=1.67 ≥ 1.5
    const r = checkRiskReward(-30, 50);
    expect(r.passes).toBe(true);
  });

  it("trailing=0 is treated as absent (not a valid proxy)", () => {
    const r = checkRiskReward(-10, null, { trailingTriggerPct: 0 });
    expect(r.passes).toBe(true);
    expect(r.reason).toBe("tp_unknown_skip");
  });

  it("negative trailing is treated as absent", () => {
    const r = checkRiskReward(-10, null, { trailingTriggerPct: -5 });
    expect(r.passes).toBe(true);
    expect(r.reason).toBe("tp_unknown_skip");
  });
});
