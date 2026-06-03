import { describe, expect, it } from "vitest";
import { calculateKellyFraction, computeFractionalKellySize, estimateKellyInputs } from "../kelly.js";


describe("kelly sizing", () => {
  it("computes the raw Kelly fraction from win probability and payoff ratio", () => {
    const fraction = calculateKellyFraction({ b: 2, p: 0.5 });
    expect(fraction).toBeCloseTo(0.25, 6);
  });

  it("estimates Kelly inputs from recent trade history and market context", () => {
    const inputs = estimateKellyInputs(
      [
        { pnl_pct: 50 },
        { pnl_pct: 30 },
        { pnl_pct: -20 },
        { pnl_pct: -10 },
        { pnl_pct: 15 },
      ],
      {
        marketCondition: "HOT",
        tokenEdgeScore: 70,
        holderStructureRisk: "LOW",
      }
    );

    expect(inputs.sample_size).toBe(5);
    expect(inputs.raw_win_rate).toBe(0.6);
    expect(inputs.p).toBeGreaterThan(inputs.raw_win_rate);
    expect(inputs.b).toBeGreaterThan(1);
  });

  it("uses fallback sizing when sample size is below threshold", () => {
    const result = computeFractionalKellySize({
      bankrollSol: 10,
      baseDeployAmountSol: 1.5,
      trades: [{ pnl_pct: 20 }, { pnl_pct: -10 }],
      minSampleTrades: 5,
    });

    expect(result.used_fallback).toBe(true);
    expect(result.deploy_amount_sol).toBe(1.5);
    expect(result.should_skip).toBe(false);
  });

  it("returns a smaller adaptive size when Kelly edge is positive", () => {
    const result = computeFractionalKellySize({
      bankrollSol: 10,
      baseDeployAmountSol: 2,
      fraction: 0.5,
      minFraction: 0.1,
      maxFraction: 0.8,
      minSampleTrades: 6,
      trades: [
        { pnl_pct: 60 },
        { pnl_pct: 40 },
        { pnl_pct: 25 },
        { pnl_pct: -15 },
        { pnl_pct: -10 },
        { pnl_pct: 30 },
      ],
      context: {
        marketCondition: "HOT",
        tokenEdgeScore: 72,
        holderStructureRisk: "LOW",
      },
    });

    expect(result.used_fallback).toBe(false);
    expect(result.should_skip).toBe(false);
    expect(result.kelly_fraction).toBeGreaterThan(0);
    expect(result.deploy_amount_sol).toBeGreaterThan(0);
    expect(result.deploy_amount_sol).toBeLessThanOrEqual(2);
  });

  it("rejects entries when the Kelly edge is negative", () => {
    const result = computeFractionalKellySize({
      bankrollSol: 10,
      baseDeployAmountSol: 2,
      minSampleTrades: 6,
      trades: [
        { pnl_pct: 10 },
        { pnl_pct: -40 },
        { pnl_pct: -35 },
        { pnl_pct: -30 },
        { pnl_pct: -20 },
        { pnl_pct: -15 },
      ],
      context: {
        marketCondition: "DEAD",
        tokenEdgeScore: 35,
        holderStructureRisk: "HIGH",
      },
    });

    expect(result.used_fallback).toBe(false);
    expect(result.should_skip).toBe(true);
    expect(result.deploy_amount_sol).toBe(0);
    expect(result.effective_fraction).toBe(0);
  });

  it("clamps payoffRatio at 5 when avgWin far exceeds avgLoss", () => {
    // avgWin=500, avgLoss=10 => raw payoffRatio=50, should be capped at 5
    const inputs = estimateKellyInputs([
      { pnl_pct: 500 },
      { pnl_pct: -10 },
    ]);
    expect(inputs.b).toBe(5);
  });

  it("enforces minSampleTrades=10 by default (returns fallback with 9 trades)", () => {
    const trades = Array.from({ length: 9 }, (_, i) => ({ pnl_pct: i % 2 === 0 ? 20 : -10 }));
    const result = computeFractionalKellySize({
      bankrollSol: 10,
      baseDeployAmountSol: 1,
      trades,
    });
    expect(result.used_fallback).toBe(true);
    expect(result.deploy_amount_sol).toBe(1);
  });

  it("volatility dampener reduces p when spread > 200", () => {
    // avgWin=180, avgLoss=60 => spread=240 > 200 => p reduced by 0.05
    const inputs = estimateKellyInputs([
      { pnl_pct: 180 },
      { pnl_pct: -60 },
    ]);
    // rawWinRate = 0.5, no context adjustments, p clamped at [0.05, 0.95],
    // then dampener applies: p = 0.5 - 0.05 = 0.45
    expect(inputs.p).toBe(0.45);
  });
});

// ─── Conviction multiplier logic (mirrors index.js _convMult formula) ────────
describe("conviction-based size multiplier (index.js _convMult)", () => {
  function convMult(score) {
    if (score >= 75) return 1.30;
    if (score >= 60) return 1.15;
    if (score >= 40) return 1.00;
    return 0.75;
  }

  it("score >= 75 → 1.30 (strong conviction, larger entry)", () => {
    expect(convMult(75)).toBe(1.30);
    expect(convMult(90)).toBe(1.30);
  });

  it("score 60-74 → 1.15 (good conviction, slightly larger)", () => {
    expect(convMult(60)).toBe(1.15);
    expect(convMult(74)).toBe(1.15);
  });

  it("score 40-59 → 1.00 (neutral / building, base size)", () => {
    expect(convMult(40)).toBe(1.00);
    expect(convMult(59)).toBe(1.00);
  });

  it("score < 40 → 0.75 (weak conviction, smaller entry)", () => {
    expect(convMult(0)).toBe(0.75);
    expect(convMult(39)).toBe(0.75);
  });

  it("undefined/null score → treated as 50 → 1.00", () => {
    // index.js uses: conviction.conviction_score ?? 50
    const s = undefined ?? 50;
    expect(convMult(s)).toBe(1.00);
  });

  it("strong conviction doubles pre-kelly amount proportionally vs weak", () => {
    const baseAmount = 0.5;
    const strongSize = parseFloat((baseAmount * convMult(80)).toFixed(4));
    const weakSize   = parseFloat((baseAmount * convMult(20)).toFixed(4));
    expect(strongSize).toBeCloseTo(0.65);  // 0.5 * 1.30
    expect(weakSize).toBeCloseTo(0.375);   // 0.5 * 0.75
    expect(strongSize / weakSize).toBeGreaterThan(1.7); // strong > 1.7x weak
  });
});
