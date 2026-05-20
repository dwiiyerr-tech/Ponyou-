import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { executeFastBuy } from "../fast-buy.js";
import { config } from "../config.js";

describe("fast-buy confirm gate", () => {
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

  it("blocks fast-track buys when confirm mode is on", async () => {
    const result = await executeFastBuy({
      token: { mint: "mint-1", symbol: "AAA" },
      deployAmountSol: 0.5,
      solPriceUsd: 150,
    });

    expect(result.blocked).toBe(true);
    expect(result.pending_confirmation).toBe(true);
    expect(result.success).toBe(false);
  });
});
