import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { swapToken } from "../tools/jupiter.js";
import { config } from "../config.js";

describe("jupiter swap confirm gate", () => {
  const originalConfirmMode = config.trading.confirmMode;
  const originalDryRun = process.env.DRY_RUN;

  beforeEach(() => {
    config.trading.confirmMode = true;
    delete process.env.DRY_RUN;
  });

  afterEach(() => {
    config.trading.confirmMode = originalConfirmMode;
    if (originalDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = originalDryRun;
  });

  it("blocks direct buy swaps when confirm mode is on", async () => {
    const result = await swapToken({
      token_in: "SOL",
      token_out: "mint-1",
      amount: 0.5,
      slippage: 1,
    });

    expect(result.blocked).toBe(true);
    expect(result.pending_confirmation).toBe(true);
    expect(result.success).toBe(false);
  });
});
