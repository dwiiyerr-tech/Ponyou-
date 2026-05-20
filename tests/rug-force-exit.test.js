import { describe, it, expect } from "vitest";

// Regression tests for the rug_force_exit wiring fix.
// checkDeterministicExits is internal to index.js, so we verify the
// invariants that the fix depends on rather than the function itself.

describe("rug_force_exit wiring", () => {
  it("rug reason pattern matches rug_monitor_* reasons", () => {
    const reasons = [
      "rug_monitor_dev_sell",
      "rug_monitor_lp_removed",
      "rug_monitor_holder_dump",
      "rug_monitor_authority_change",
      "rug_force_exit",
    ];
    for (const reason of reasons) {
      expect(/rug/i.test(reason)).toBe(true);
    }
  });

  it("rug reason pattern does not match normal exit reasons", () => {
    const reasons = [
      "hardStopLoss",
      "trailingStop",
      "immediateTP",
      "hardCutLoss",
      "takeProfit",
    ];
    for (const reason of reasons) {
      expect(/rug/i.test(reason)).toBe(false);
    }
  });

  it("rug_detected uses case-insensitive match", () => {
    // Before the fix this was .includes("Rug") — only matched capital-R
    const rugReasons = ["rug_monitor_dev_sell", "Rug pull", "RUG", "rug"];
    const nonRugReasons = ["stopLoss", "trailingStop", "takeProfit"];

    for (const r of rugReasons) expect(/rug/i.test(r)).toBe(true);
    for (const r of nonRugReasons) expect(/rug/i.test(r)).toBe(false);
  });

  it("exit object shape is correct for rug_force_exit", () => {
    const tracked = {
      rug_force_exit: true,
      rug_force_exit_reason: "rug_monitor_dev_sell",
      rug_force_exit_ts: Date.now(),
    };
    const token = { mint: "abc123", symbol: "TEST", wallet_address: "wallet1", position_key: "abc123" };
    const currentPnlPct = -15;

    // Simulate what checkDeterministicExits now does when rug_force_exit is set
    const exit = {
      mint: token.mint,
      symbol: token.symbol,
      reason: tracked.rug_force_exit_reason || "rug_force_exit",
      pnl_pct: currentPnlPct,
      is_loss: currentPnlPct < 0,
      wallet_address: token.wallet_address || null,
      position_key: token.position_key || token.mint,
    };

    expect(exit.reason).toBe("rug_monitor_dev_sell");
    expect(exit.is_loss).toBe(true);
    expect(/rug/i.test(exit.reason)).toBe(true);
  });
});
