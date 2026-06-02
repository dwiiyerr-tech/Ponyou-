import { describe, it, expect } from "vitest";
import { applyGmgnRiskPenalty } from "../tools/hunter-agent.js";

describe("applyGmgnRiskPenalty", () => {
  it("returns score unchanged and empty reasons when risk is null", () => {
    const [score, reasons] = applyGmgnRiskPenalty(80, null);
    expect(score).toBe(80);
    expect(reasons).toEqual([]);
  });

  it("returns score unchanged and empty reasons when all risk fields are null", () => {
    const [score, reasons] = applyGmgnRiskPenalty(70, {
      rug_ratio: null, sniper_count: null, bundler_rate: null,
      rat_trader_amount_rate: null, suspected_insider_hold_rate: null,
    });
    expect(score).toBe(70);
    expect(reasons).toEqual([]);
  });

  it("applies -20 penalty for rug_ratio just above 0.35 threshold", () => {
    const [score, reasons] = applyGmgnRiskPenalty(80, { rug_ratio: 0.36 });
    expect(score).toBe(60);
    expect(reasons[0]).toMatch(/rug_ratio/);
  });

  it("does not penalise rug_ratio at exactly 0.35 (boundary not exceeded)", () => {
    const [score, reasons] = applyGmgnRiskPenalty(80, { rug_ratio: 0.35 });
    expect(score).toBe(80);
    expect(reasons).toEqual([]);
  });

  it("applies -15 penalty for sniper_count just above 30 threshold", () => {
    const [score, reasons] = applyGmgnRiskPenalty(80, { sniper_count: 31 });
    expect(score).toBe(65);
    expect(reasons[0]).toMatch(/snipers/);
  });

  it("applies -15 penalty for bundler_rate just above 0.25", () => {
    const [score, reasons] = applyGmgnRiskPenalty(80, { bundler_rate: 0.26 });
    expect(score).toBe(65);
    expect(reasons[0]).toMatch(/bundlers/);
  });

  it("applies -10 penalty for rat_trader_amount_rate just above 0.3", () => {
    const [score, reasons] = applyGmgnRiskPenalty(80, { rat_trader_amount_rate: 0.31 });
    expect(score).toBe(70);
    expect(reasons[0]).toMatch(/rats/);
  });

  it("applies -10 penalty for suspected_insider_hold_rate just above 0.25", () => {
    const [score, reasons] = applyGmgnRiskPenalty(80, { suspected_insider_hold_rate: 0.26 });
    expect(score).toBe(70);
    expect(reasons[0]).toMatch(/insiders/);
  });

  it("stacks all penalties and clamps to 0", () => {
    const [score, reasons] = applyGmgnRiskPenalty(50, {
      rug_ratio: 0.9,
      sniper_count: 100,
      bundler_rate: 0.8,
      rat_trader_amount_rate: 0.8,
      suspected_insider_hold_rate: 0.8,
    });
    expect(score).toBe(0); // 50 - 20 - 15 - 15 - 10 - 10 = -20, clamped to 0
    expect(reasons).toHaveLength(5);
  });

  it("score of exactly 70 after penalty is PRIORITY tier boundary (caller check)", () => {
    // rug_ratio=0.9 → -20 penalty from 90
    const [score] = applyGmgnRiskPenalty(90, { rug_ratio: 0.9 });
    expect(score).toBe(70);
  });

  it("score of exactly 50 after penalty is GOOD tier boundary (caller check)", () => {
    // bundler_rate=0.9 → -15 penalty from 65
    const [score] = applyGmgnRiskPenalty(65, { bundler_rate: 0.9 });
    expect(score).toBe(50);
  });

  it("appends reasons to returned array, not mutating input", () => {
    const risk = { rug_ratio: 0.5, sniper_count: 50 };
    const [, reasons] = applyGmgnRiskPenalty(80, risk);
    expect(reasons).toHaveLength(2);
    expect(reasons.some(r => r.includes("rug_ratio"))).toBe(true);
    expect(reasons.some(r => r.includes("snipers"))).toBe(true);
  });
});
