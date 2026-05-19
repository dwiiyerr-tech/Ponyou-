import { describe, expect, it } from "vitest";
import { computeProfitSweepAmount } from "../vault.js";

describe("computeProfitSweepAmount", () => {
  it("moves 35% of profit by default", () => {
    const result = computeProfitSweepAmount(100, 20);
    expect(result.amount_usd).toBe(35);
    expect(result.amount_sol).toBeCloseTo(1.75);
  });

  it("returns zero when inputs are invalid", () => {
    expect(computeProfitSweepAmount(0, 20).amount_sol).toBe(0);
    expect(computeProfitSweepAmount(10, 0).amount_sol).toBe(0);
  });
});
