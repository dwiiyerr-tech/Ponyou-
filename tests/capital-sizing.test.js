import { describe, expect, it } from "vitest";
import { getCapitalAwareSizing } from "../capital-sizing.js";

const DEFAULT_CFG = {
  microThreshold: 50,
  fullThreshold: 200,
  microFlat: { HOT: 0.15, WARM: 0.08 },
  growthCap: 0.20,
  growthFallbackFraction: 0.10,
};

// Helper: 6 modest trades — low payoff ratio, Kelly half will be under 20% cap
// winRate=0.5, avgWin=20%, avgLoss=15%, payoffRatio≈1.33 → Kelly≈0.124 → half≈0.031 → hits minFraction 0.1 → deploy=10% bankroll < 20% cap
const MODEST_TRADES = [
  { pnl_pct: 20 }, { pnl_pct: 20 }, { pnl_pct: 20 },
  { pnl_pct: -15 }, { pnl_pct: -15 }, { pnl_pct: -15 },
];

// Helper: 6 trades with extreme edge → Kelly will exceed 20% cap
const HIGH_EDGE_TRADES = [
  { pnl_pct: 60 }, { pnl_pct: 60 }, { pnl_pct: 60 },
  { pnl_pct: 60 }, { pnl_pct: 60 }, { pnl_pct: -5 },
];

describe("getCapitalAwareSizing — MICRO tier (capitalUsd < 50)", () => {
  it("returns flat 15% of bankroll for HOT regime", () => {
    // bankrollSol=0.15 * solPriceUsd=200 = capitalUsd=30 → MICRO
    const result = getCapitalAwareSizing({
      bankrollSol: 0.15,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("MICRO");
    expect(result.method).toBe("regime-flat");
    expect(result.skipped).toBe(false);
    expect(result.effective_fraction).toBeCloseTo(0.15);
    // deploy = min(0.15 * 0.15, 0.5) = 0.0225
    expect(result.deploy_amount_sol).toBeCloseTo(0.0225, 3);
    expect(result.capped_at).toBeNull();
  });

  it("returns flat 8% of bankroll for WARM regime", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.15,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "WARM",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("MICRO");
    expect(result.effective_fraction).toBeCloseTo(0.08);
    // deploy = min(0.15 * 0.08, 0.5) = 0.012
    expect(result.deploy_amount_sol).toBeCloseTo(0.012, 3);
    expect(result.skipped).toBe(false);
  });

  it("skips entry for DEAD regime", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.15,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "DEAD",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("MICRO");
    expect(result.skipped).toBe(true);
    expect(result.deploy_amount_sol).toBe(0);
  });

  it("skips entry for COLD regime", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.15,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "COLD",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.skipped).toBe(true);
    expect(result.deploy_amount_sol).toBe(0);
  });

  it("respects baseDeployAmountSol as upper cap", () => {
    // bankroll 0.1 SOL × 200 = $20 → MICRO
    // flatFraction HOT = 15% → 0.1 * 0.15 = 0.015
    // baseDeployAmountSol = 0.005 < 0.015 → respect base
    const result = getCapitalAwareSizing({
      bankrollSol: 0.1,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.005,
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.deploy_amount_sol).toBeCloseTo(0.005, 3);
  });

  it("boundary: capitalUsd=49.99 → MICRO", () => {
    // 0.2499 SOL × 200 = 49.98 → MICRO
    const result = getCapitalAwareSizing({
      bankrollSol: 0.2499,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("MICRO");
  });
});

describe("getCapitalAwareSizing — GROWTH tier ($50–$200)", () => {
  it("uses growth-fallback flat 10% when no trade history", () => {
    // bankrollSol=0.5 × solPriceUsd=200 = capitalUsd=100 → GROWTH
    const result = getCapitalAwareSizing({
      bankrollSol: 0.5,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: [],
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
    expect(result.method).toBe("growth-fallback");
    expect(result.used_fallback).toBe(true);
    // deploy = min(0.5 * 0.10, 0.5) = 0.05
    expect(result.deploy_amount_sol).toBeCloseTo(0.05, 3);
  });

  it("uses half-kelly and no cap when effective fraction < 20%", () => {
    // MODEST_TRADES: winRate=0.5, payoffRatio≈1.33 → low Kelly → stays under 20% cap
    const result = getCapitalAwareSizing({
      bankrollSol: 0.5,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: MODEST_TRADES,
      context: { marketCondition: "WARM", tokenEdgeScore: 50, holderStructureRisk: "LOW" },
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
    expect(result.method).toBe("half-kelly");
    expect(result.used_fallback).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.deploy_amount_sol).toBeGreaterThan(0);
    // Should be under 20% cap = 0.5 * 0.20 = 0.10
    expect(result.deploy_amount_sol).toBeLessThanOrEqual(0.10);
    expect(result.capped_at).toBeNull();
  });

  it("caps deploy at 20% of bankroll when half-kelly exceeds cap", () => {
    // HIGH_EDGE_TRADES → very high Kelly fraction → after halving still > 20%
    const result = getCapitalAwareSizing({
      bankrollSol: 0.5,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: HIGH_EDGE_TRADES,
      context: { marketCondition: "HOT", tokenEdgeScore: 80, holderStructureRisk: "LOW" },
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
    expect(result.method).toBe("half-kelly");
    // deploy capped at 20% of bankroll = 0.5 * 0.20 = 0.10
    expect(result.deploy_amount_sol).toBeCloseTo(0.10, 2);
    expect(result.capped_at).not.toBeNull();
  });

  it("boundary: capitalUsd=50 → GROWTH", () => {
    // 0.25 SOL × 200 = $50 → GROWTH
    const result = getCapitalAwareSizing({
      bankrollSol: 0.25,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.25,
      trades: [],
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
  });

  it("boundary: capitalUsd=199.99 → GROWTH", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.9999,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: [],
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
  });
});

describe("getCapitalAwareSizing — FULL tier (>= $200)", () => {
  it("boundary: capitalUsd=200 → FULL", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 1.0,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: [],
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("FULL");
  });

  it("uses full-kelly with no extra cap", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 1.5,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: MODEST_TRADES,
      context: { marketCondition: "WARM", tokenEdgeScore: 50, holderStructureRisk: "LOW" },
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("FULL");
    expect(result.method).toBe("full-kelly");
    expect(result.capped_at).toBeNull();
    expect(result.deploy_amount_sol).toBeGreaterThan(0);
  });
});

describe("getCapitalAwareSizing — output shape", () => {
  it("always returns required fields", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.1,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.1,
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(typeof result.deploy_amount_sol).toBe("number");
    expect(typeof result.kelly_fraction).toBe("number");
    expect(typeof result.effective_fraction).toBe("number");
    expect(typeof result.used_fallback).toBe("boolean");
    expect(typeof result.should_skip).toBe("boolean");
    expect(["MICRO", "GROWTH", "FULL"]).toContain(result.tier);
    expect(["regime-flat", "half-kelly", "full-kelly", "growth-fallback"]).toContain(result.method);
    expect(typeof result.capital_usd).toBe("number");
  });

  it("skipped result has deploy_amount_sol = 0 and should_skip = true", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.1,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "DEAD",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.should_skip).toBe(true);
    expect(result.deploy_amount_sol).toBe(0);
  });
});
