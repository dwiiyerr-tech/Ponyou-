import { describe, it, expect } from "vitest";
import { matchStrategyForCoin } from "../tools/strategy-matcher.js";

// Helpers for building canonical token shapes ─────────────────────────
function lowCapNewToken(overrides = {}) {
  // Fresh pump.fun-style: tiny mcap, few holders, recently launched
  return {
    fdv_usd: 50_000,
    holders: 80,
    top10_concentration_pct: 45,
    holder_age_hours: 2,
    ath_distance_pct: -10,
    smart_money: { holders: 0 },
    ...overrides,
  };
}

function midCapMatureToken(overrides = {}) {
  return {
    fdv_usd: 500_000,
    holders: 1200,
    top10_concentration_pct: 35,
    holder_age_hours: 72,
    ath_distance_pct: -25,
    smart_money: { holders: 3 },
    ...overrides,
  };
}

function dipBuyCandidate(overrides = {}) {
  return {
    fdv_usd: 300_000,
    holders: 600,
    top10_concentration_pct: 40,
    holder_age_hours: 24,
    ath_distance_pct: -55,
    smart_money: { holders: 0 },
    ...overrides,
  };
}

function dayPhaseCandidate(overrides = {}) {
  return {
    fdv_usd: 5_000_000,
    holders: 800,
    top10_concentration_pct: 35,
    holder_age_hours: 48,
    ath_distance_pct: -55,
    smart_money: { holders: 1 },
    ...overrides,
  };
}

describe("matchStrategyForCoin — basic scoring", () => {
  it("returns a result with best, active, all, suggest_override", () => {
    const r = matchStrategyForCoin({
      token: lowCapNewToken(),
      activeStrategyId: "scalping",
      marketCondition: "HOT",
    });
    expect(r).toHaveProperty("best");
    expect(r).toHaveProperty("active");
    expect(r).toHaveProperty("all");
    expect(r).toHaveProperty("suggest_override");
    expect(r).toHaveProperty("selected_strategy");
    expect(Array.isArray(r.all)).toBe(true);
    expect(r.all.length).toBe(6); // 6 preset strategies
  });

  it("sorts all strategies by descending score", () => {
    const r = matchStrategyForCoin({
      token: midCapMatureToken(),
      activeStrategyId: "scalping",
      marketCondition: "NORMAL",
    });
    for (let i = 1; i < r.all.length; i++) {
      expect(r.all[i - 1].score).toBeGreaterThanOrEqual(r.all[i].score);
    }
  });
});

describe("matchStrategyForCoin — hard filter exclusion", () => {
  it("scores 0 for strategies whose mcap window excludes the token", () => {
    // $5M FDV — only day_phase_trading allows this range
    const token = dayPhaseCandidate();
    const r = matchStrategyForCoin({
      token,
      activeStrategyId: "scalping",
      marketCondition: "NORMAL",
    });
    const scalping = r.all.find((s) => s.id === "scalping");
    const sniper = r.all.find((s) => s.id === "sniper");
    expect(scalping.score).toBe(0); // no min_mcap defined → passes hard gates, but...
    expect(sniper.score).toBe(0); // max_mcap_usd=200K excludes 5M
  });

  it("scores 0 when holder count below min_holders", () => {
    const token = midCapMatureToken({ holders: 200 });
    const r = matchStrategyForCoin({
      token,
      activeStrategyId: "scalping",
      marketCondition: "NORMAL",
    });
    // smart_money requires min_holders=1000 → excluded
    expect(r.all.find((s) => s.id === "smart_money").score).toBe(0);
    // day_phase_trading requires min_holders=500 → excluded
    expect(r.all.find((s) => s.id === "day_phase_trading").score).toBe(0);
  });

  it("scores 0 when top10 concentration above max_top10_pct", () => {
    const token = midCapMatureToken({ top10_concentration_pct: 60 });
    const r = matchStrategyForCoin({
      token,
      activeStrategyId: "scalping",
      marketCondition: "NORMAL",
    });
    // smart_money has max_top10_pct=50 → excluded
    expect(r.all.find((s) => s.id === "smart_money").score).toBe(0);
  });
});

describe("matchStrategyForCoin — strategy-specific signals", () => {
  it("picks day_phase_trading for swing setup (large FDV + dipped + COLD regime)", () => {
    const r = matchStrategyForCoin({
      token: dayPhaseCandidate(),
      activeStrategyId: "scalping",
      marketCondition: "COLD",
    });
    expect(r.best.id).toBe("day_phase_trading");
    expect(r.suggest_override).toBe(true);
    expect(r.selected_strategy).toBe("day_phase_trading");
  });

  it("picks dip_buy when token is meaningfully below ATH", () => {
    const r = matchStrategyForCoin({
      token: dipBuyCandidate(),
      activeStrategyId: "scalping",
      marketCondition: "NORMAL",
    });
    expect(r.best.id).toBe("dip_buy");
  });

  it("boosts smart_money when smart wallets present", () => {
    const token = midCapMatureToken({ smart_money: { holders: 5 } });
    const r = matchStrategyForCoin({
      token,
      activeStrategyId: "scalping",
      marketCondition: "NORMAL",
    });
    const smartMoney = r.all.find((s) => s.id === "smart_money");
    expect(smartMoney.score).toBeGreaterThan(0);
    expect(smartMoney.reasons.some((r) => /smart-money/.test(r))).toBe(true);
  });
});

describe("matchStrategyForCoin — override margin", () => {
  it("does not suggest override when best is only marginally better than active", () => {
    // Construct a token where active and best score close together
    const token = midCapMatureToken({ smart_money: { holders: 0 } });
    const r = matchStrategyForCoin({
      token,
      activeStrategyId: "dip_buy",
      marketCondition: "NORMAL",
      overrideMargin: 0.99,
    });
    expect(r.suggest_override).toBe(false);
    expect(r.selected_strategy).toBe("dip_buy");
  });

  it("does suggest override when best clearly exceeds active by margin", () => {
    const r = matchStrategyForCoin({
      token: dayPhaseCandidate(),
      activeStrategyId: "scalping", // wrong fit (max_mcap excludes 5M)
      marketCondition: "COLD",
      overrideMargin: 0.15,
    });
    expect(r.suggest_override).toBe(true);
    expect(r.selected_strategy).not.toBe("scalping");
  });

  it("does not override when active strategy is also the best fit", () => {
    const r = matchStrategyForCoin({
      token: dayPhaseCandidate(),
      activeStrategyId: "day_phase_trading",
      marketCondition: "COLD",
    });
    expect(r.suggest_override).toBe(false);
    expect(r.selected_strategy).toBe("day_phase_trading");
  });
});

describe("matchStrategyForCoin — degen fallback", () => {
  it("scores degen positive on tokens within its windows but with no other fit", () => {
    // Mid-range FDV inside degen window (5K-100K), holder age >=1h, no smart money,
    // no significant dip, no fresh launch — only degen catches it.
    const token = lowCapNewToken({
      fdv_usd: 30_000,
      holders: 80,
      holder_age_hours: 6,
      ath_distance_pct: -5,
    });
    const r = matchStrategyForCoin({
      token,
      activeStrategyId: "scalping",
      marketCondition: "NORMAL",
    });
    const degen = r.all.find((s) => s.id === "degen");
    // degen always gets at least its residual when not hard-filtered out
    expect(degen.score).toBeGreaterThan(0);
  });
});

describe("matchStrategyForCoin — defensive behavior", () => {
  it("handles missing token fields gracefully", () => {
    const r = matchStrategyForCoin({
      token: {},
      activeStrategyId: "scalping",
      marketCondition: "NORMAL",
    });
    expect(r.best).toBeTruthy();
    expect(Number.isFinite(r.best.score)).toBe(true);
  });

  it("handles unknown activeStrategyId without throwing", () => {
    const r = matchStrategyForCoin({
      token: lowCapNewToken(),
      activeStrategyId: "nonexistent",
      marketCondition: "NORMAL",
    });
    expect(r.active.id).toBe("nonexistent");
    expect(r.active.score).toBe(0);
  });
});
