import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    exitSlippage: { steps: [1, 5, 10, 20], maxAttempts: 4 },
  },
}));

import { getExitSlippage, validateSlippageConfig, withProgressiveSlippage } from "../exit-slippage.js";

describe("getExitSlippage", () => {
  it("returns 1% for attempt 1", () => {
    expect(getExitSlippage(1)).toBeCloseTo(0.01);
  });
  it("returns 5% for attempt 2", () => {
    expect(getExitSlippage(2)).toBeCloseTo(0.05);
  });
  it("returns 10% for attempt 3", () => {
    expect(getExitSlippage(3)).toBeCloseTo(0.10);
  });
  it("returns 20% for attempt 4", () => {
    expect(getExitSlippage(4)).toBeCloseTo(0.20);
  });
  it("clamps to last step for attempt > maxAttempts", () => {
    expect(getExitSlippage(99)).toBeCloseTo(0.20);
  });
});

describe("validateSlippageConfig", () => {
  it("does not throw with valid config", () => {
    expect(() => validateSlippageConfig()).not.toThrow();
  });
});

describe("withProgressiveSlippage", () => {
  it("returns on first success", async () => {
    const exitFn = vi.fn().mockResolvedValue({ success: true });
    const { result, attempt, stuck } = await withProgressiveSlippage(exitFn);
    expect(stuck).toBe(false);
    expect(attempt).toBe(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0.01);
  });

  it("retries with increasing slippage until success", async () => {
    const exitFn = vi.fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });
    const { attempt, stuck } = await withProgressiveSlippage(exitFn);
    expect(stuck).toBe(false);
    expect(attempt).toBe(3);
    expect(exitFn).toHaveBeenNthCalledWith(1, 0.01);
    expect(exitFn).toHaveBeenNthCalledWith(2, 0.05);
    expect(exitFn).toHaveBeenNthCalledWith(3, 0.10);
  });

  it("returns stuck=true when all attempts fail", async () => {
    const exitFn = vi.fn().mockResolvedValue({ success: false, error: "timeout" });
    const { stuck, attempt } = await withProgressiveSlippage(exitFn);
    expect(stuck).toBe(true);
    expect(attempt).toBe(4);
    expect(exitFn).toHaveBeenCalledTimes(4);
  });

  it("treats dry_run as success", async () => {
    const exitFn = vi.fn().mockResolvedValue({ success: false, dry_run: true });
    const { stuck } = await withProgressiveSlippage(exitFn);
    expect(stuck).toBe(false);
  });

  it("respects maxAttempts override", async () => {
    const exitFn = vi.fn().mockResolvedValue({ success: false });
    const { stuck, attempt } = await withProgressiveSlippage(exitFn, { maxAttempts: 2 });
    expect(stuck).toBe(true);
    expect(attempt).toBe(2);
    expect(exitFn).toHaveBeenCalledTimes(2);
  });

  // M3 regression: an indeterminate swap (sent but unconfirmed) must stop the
  // retry loop immediately. Retrying at higher slippage risks a double-sell.
  it("stops retrying on indeterminate result — does not escalate slippage (M3)", async () => {
    const exitFn = vi.fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false, indeterminate: true });
    const { stuck, indeterminate, attempt } = await withProgressiveSlippage(exitFn);
    expect(stuck).toBe(false);
    expect(indeterminate).toBe(true);
    expect(attempt).toBe(2);
    // Must NOT have fired a 3rd attempt at higher slippage
    expect(exitFn).toHaveBeenCalledTimes(2);
  });
});
