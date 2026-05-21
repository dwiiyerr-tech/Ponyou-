import { describe, it, expect } from "vitest";
import { RiskGuard, createRiskGuard } from "../tools/risk_guard.js";

describe("RiskGuard", () => {
  const guard = new RiskGuard();

  it("passes valid trade", () => {
    const r = guard.check({ balanceSOL: 2.0, tradeSizeSOL: 0.1, slippageBps: 100 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("blocks when balance below 1 SOL minimum", () => {
    const r = guard.check({ balanceSOL: 0.99, tradeSizeSOL: 0.1, slippageBps: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/balance.*minimum/i);
  });

  it("allows when balance exactly 1 SOL", () => {
    const r = guard.check({ balanceSOL: 1.0, tradeSizeSOL: 0.1, slippageBps: 100 });
    expect(r.ok).toBe(true);
  });

  it("blocks trade size above 0.25 SOL", () => {
    const r = guard.check({ balanceSOL: 5.0, tradeSizeSOL: 0.26, slippageBps: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/max/i);
  });

  it("allows trade size exactly 0.25 SOL", () => {
    const r = guard.check({ balanceSOL: 5.0, tradeSizeSOL: 0.25, slippageBps: 100 });
    expect(r.ok).toBe(true);
  });

  it("blocks when post-trade balance would drop below fee reserve", () => {
    // balance=1.1, trade=1.1-0.04=1.06 → post=0.04 < 0.05
    const r = guard.check({ balanceSOL: 1.1, tradeSizeSOL: 0.25, slippageBps: 100 });
    // 1.1 - 0.25 = 0.85 >= 0.05, should pass
    expect(r.ok).toBe(true);

    // balance=1.05, trade=0.25 → post=0.80 OK
    const r2 = guard.check({ balanceSOL: 1.05, tradeSizeSOL: 0.25, slippageBps: 100 });
    expect(r2.ok).toBe(true);

    // Force the fee reserve violation: balance=1.08, trade=0.25, post=0.83 OK
    // Edge case: balance=1.0, trade=0.25, post=0.75 >= 0.05 OK
    // True failure: balance=1.0, trade=0.25, but set feeReserve=0.80
    const strictGuard = new RiskGuard({ feeReserveSOL: 0.80 });
    const r3 = strictGuard.check({ balanceSOL: 1.0, tradeSizeSOL: 0.25, slippageBps: 100 });
    expect(r3.ok).toBe(false);
    expect(r3.reason).toMatch(/fee/i);
  });

  it("blocks slippage above 300bps", () => {
    const r = guard.check({ balanceSOL: 2.0, tradeSizeSOL: 0.1, slippageBps: 301 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/slippage/i);
  });

  it("allows slippage exactly 300bps", () => {
    const r = guard.check({ balanceSOL: 2.0, tradeSizeSOL: 0.1, slippageBps: 300 });
    expect(r.ok).toBe(true);
  });

  it("createRiskGuard factory returns working instance", () => {
    const g = createRiskGuard({ maxTradeSOL: 0.1 });
    const r = g.check({ balanceSOL: 2.0, tradeSizeSOL: 0.15, slippageBps: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/max/i);
  });
});
