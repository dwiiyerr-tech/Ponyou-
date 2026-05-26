import { describe, it, expect } from "vitest";
import {
  getEffectiveStopLoss,
  getEffectiveImmediateTakeProfit,
  checkROI,
  checkTrailingStop,
  checkPartialTP,
  getMcapTier,
  getTierExecutionProfile,
} from "../strategy.js";

describe("getEffectiveStopLoss", () => {
  it("falls back to active strategy default when user pct is null", () => {
    const sl = getEffectiveStopLoss(null);
    expect(sl).toBeLessThan(0);
    expect(Number.isFinite(sl)).toBe(true);
  });

  it("uses user override when negative number provided (as percent)", () => {
    expect(getEffectiveStopLoss(-20)).toBe(-0.2);
    expect(getEffectiveStopLoss(-7.5)).toBe(-0.075);
  });

  it("ignores positive override (only negative makes sense for stop-loss)", () => {
    // 20 > 0 → fall back to strategy default
    const fallback = getEffectiveStopLoss(null);
    expect(getEffectiveStopLoss(20)).toBe(fallback);
  });

  it("ignores non-finite overrides (NaN, Infinity)", () => {
    const fallback = getEffectiveStopLoss(null);
    expect(getEffectiveStopLoss(NaN)).toBe(fallback);
    expect(getEffectiveStopLoss(-Infinity)).toBe(fallback);
  });
});

describe("getEffectiveImmediateTakeProfit", () => {
  it("returns null when user pct is null (caller falls back to ROI table)", () => {
    expect(getEffectiveImmediateTakeProfit(null)).toBeNull();
  });

  it("returns decimal when user provides positive percent", () => {
    expect(getEffectiveImmediateTakeProfit(25)).toBe(0.25);
    expect(getEffectiveImmediateTakeProfit(100)).toBe(1.0);
  });

  it("returns null for non-positive overrides", () => {
    expect(getEffectiveImmediateTakeProfit(0)).toBeNull();
    expect(getEffectiveImmediateTakeProfit(-5)).toBeNull();
    expect(getEffectiveImmediateTakeProfit(NaN)).toBeNull();
  });
});

describe("checkROI", () => {
  it("returns exit=false when age and PnL below all thresholds", () => {
    expect(checkROI(0.5, 1, "NORMAL").exit).toBe(false);
  });

  it("returns exit=true when age + PnL crosses a ROI threshold", () => {
    // Default scalping strategy has minimal_roi entries; trigger one by feeding
    // very long age + very high PnL (should hit the 0-minute "infinity" tier).
    const result = checkROI(120, 100, "NORMAL");
    expect(result.exit).toBe(true);
    expect(result.reason).toContain("ROI");
  });

  it("falls back to minimal_roi when marketCondition has no preset", () => {
    const result = checkROI(120, 100, "NONEXISTENT_CONDITION");
    expect(typeof result.exit).toBe("boolean");
  });
});

describe("checkTrailingStop", () => {
  it("returns exit=false when peak below positive_offset", () => {
    // peak 0.01 is below typical positive_offset (e.g. 0.03)
    expect(checkTrailingStop(0.5, 0.01).exit).toBe(false);
  });

  it("returns exit=true when current drops > positive_distance below peak", () => {
    // peak 50%, current 30% → 20% drop, well past trailing distance
    const result = checkTrailingStop(30, 50);
    expect(result.exit).toBe(true);
    expect(result.reason).toMatch(/Trailing Stop/);
  });

  it("returns exit=false while still near peak", () => {
    // peak 10%, current 9% → tiny drop, below trailing distance
    const result = checkTrailingStop(9, 10);
    expect(result.exit).toBe(false);
  });
});

describe("checkPartialTP", () => {
  it("returns trigger=false when alreadyDone is true", () => {
    expect(checkPartialTP(100, true).trigger).toBe(false);
  });

  it("returns trigger=false when PnL below threshold", () => {
    expect(checkPartialTP(0, false).trigger).toBe(false);
  });

  it("returns trigger=false when active strategy has partial_tp disabled", () => {
    // Default scalping preset has partial_tp.enabled=false — confirm the gate.
    expect(checkPartialTP(200, false).trigger).toBe(false);
  });
});

describe("getMcapTier", () => {
  it.each([
    [50_000, "NEW_PAIR"],
    [1_000_000, "MICRO_CAP"],
    [20_000_000, "MID_CAP"],
    [100_000_000, "HIGH_CAP"],
    [500_000_000, "CEX_LEVEL"],
  ])("classifies mcap=$%i as %s", (mcap, expected) => {
    expect(getMcapTier(mcap).tier).toBe(expected);
  });

  it("each tier has desc + guidance strings", () => {
    for (const mcap of [50_000, 1_000_000, 20_000_000, 100_000_000, 500_000_000]) {
      const tier = getMcapTier(mcap);
      expect(typeof tier.desc).toBe("string");
      expect(typeof tier.guidance).toBe("string");
      expect(tier.desc.length).toBeGreaterThan(0);
    }
  });
});

describe("getTierExecutionProfile", () => {
  it("uses sell-only mode for high-cap tokens (scalping strategies)", () => {
    const profile = getTierExecutionProfile(60_000_000);
    expect(profile.sell_only).toBe(true);
    // HIGH_CAP for non-swing: still blocks entry
    expect(profile.size_multiplier).toBe(0);
  });

  it("allows high-cap entry for swing strategies", () => {
    const profile = getTierExecutionProfile(60_000_000, "day_phase_trading");
    expect(profile.sell_only).toBe(false);
    expect(profile.size_multiplier).toBe(1.0);
    expect(profile.use_technicals).toBe(true);
  });

  it("always sell-only for CEX_LEVEL regardless of strategy", () => {
    const profile = getTierExecutionProfile(250_000_000, "day_phase_trading");
    expect(profile.sell_only).toBe(true);
  });

  it("uses technicals for micro caps", () => {
    const profile = getTierExecutionProfile(500_000);
    expect(profile.sell_only).toBe(false);
    expect(profile.use_technicals).toBe(true);
  });
});
