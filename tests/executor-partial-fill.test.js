// Regression tests for split-swap partial fills. A multi-wallet adaptive
// swap executes legs sequentially; if a later leg fails, earlier legs have
// already bought real tokens. The overall result reports success:false, but
// those filled legs MUST still be tracked or the bot orphans live positions
// (bought, never managed, never sold). selectFilledExecutions is the shared
// helper both consumers (screener cron + confirm-intent) use to pick the
// legs worth tracking.

import { describe, it, expect } from "vitest";
import { selectFilledExecutions } from "../tools/executor.js";

const FALLBACK = { wallet_address: "FALLBACK_WALLET", amount: 0.5 };

describe("selectFilledExecutions — partial-fill tracking", () => {
  it("single swap success → tracks the synthesized fallback leg", () => {
    const legs = selectFilledExecutions({ success: true, wallet_address: "W1" }, FALLBACK);
    expect(legs).toEqual([FALLBACK]);
  });

  it("single swap dry_run → tracks the fallback leg", () => {
    const legs = selectFilledExecutions({ dry_run: true }, FALLBACK);
    expect(legs).toEqual([FALLBACK]);
  });

  it("single swap failure → tracks nothing", () => {
    const legs = selectFilledExecutions({ success: false, error: "no route" }, FALLBACK);
    expect(legs).toEqual([]);
  });

  it("split full success → tracks every leg, fallback ignored", () => {
    const result = {
      success: true,
      split_execution: true,
      executions: [
        { wallet_address: "A", amount: 0.3, success: true },
        { wallet_address: "B", amount: 0.3, success: true },
      ],
    };
    const legs = selectFilledExecutions(result, FALLBACK);
    expect(legs.map(l => l.wallet_address)).toEqual(["A", "B"]);
  });

  it("split PARTIAL fill → tracks only the legs that filled (the bug)", () => {
    // Leg A bought; leg B failed and aborted the split. Overall success:false,
    // but A is a real live position that must be tracked.
    const result = {
      success: false,
      partial_success: true,
      error: "split execution failed",
      executions: [
        { wallet_address: "A", amount: 0.3, success: true },
        { wallet_address: "B", amount: 0.3, success: false, error: "slippage" },
      ],
    };
    const legs = selectFilledExecutions(result, FALLBACK);
    expect(legs).toHaveLength(1);
    expect(legs[0].wallet_address).toBe("A");
  });

  it("split fully failed (first leg fails) → tracks nothing", () => {
    const result = {
      success: false,
      executions: [{ wallet_address: "A", amount: 0.3, success: false }],
    };
    expect(selectFilledExecutions(result, FALLBACK)).toEqual([]);
  });

  it("split with a dry_run leg counts it as filled", () => {
    const result = {
      success: false,
      executions: [
        { wallet_address: "A", amount: 0.3, dry_run: true },
        { wallet_address: "B", amount: 0.3, success: false },
      ],
    };
    const legs = selectFilledExecutions(result, FALLBACK);
    expect(legs.map(l => l.wallet_address)).toEqual(["A"]);
  });

  it("no fallback provided + single success → empty (caller opts out)", () => {
    expect(selectFilledExecutions({ success: true })).toEqual([]);
  });

  it("null/garbage result → empty, never throws", () => {
    expect(selectFilledExecutions(null, FALLBACK)).toEqual([]);
    expect(selectFilledExecutions(undefined)).toEqual([]);
    expect(selectFilledExecutions({})).toEqual([]);
  });
});
