import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetExecutionQualityForTests,
  getExecutionQualityAssessment,
  rankWalletExecutionCandidates,
  recordExecutionQuality,
} from "../execution-quality-memory.js";

beforeEach(() => {
  _resetExecutionQualityForTests();
});

describe("execution quality memory", () => {
  it("upgrades a wallet-route after repeated successful executions", () => {
    for (let i = 0; i < 3; i++) {
      recordExecutionQuality({
        walletAddress: "walletA",
        provider: "jupiter_ultra",
        mode: "buy",
        split: false,
        marketCondition: "HOT",
        slippage: 0.5,
        success: true,
        latencyMs: 1200,
      });
    }

    const assessment = getExecutionQualityAssessment({
      walletAddress: "walletA",
      provider: "jupiter_ultra",
      mode: "buy",
      split: false,
      marketCondition: "HOT",
      slippage: 0.5,
    });

    expect(assessment.quality_score).toBeGreaterThan(60);
    expect(assessment.stance).toBe("preferred");
    expect(assessment.size_multiplier).toBeGreaterThan(1);
  });

  it("penalizes weak routes after repeated failures", () => {
    for (let i = 0; i < 3; i++) {
      recordExecutionQuality({
        walletAddress: "walletB",
        provider: "jupiter_ultra",
        mode: "buy",
        split: false,
        marketCondition: "HOT",
        slippage: 1.5,
        success: false,
        latencyMs: 6000,
      });
    }

    const assessment = getExecutionQualityAssessment({
      walletAddress: "walletB",
      provider: "jupiter_ultra",
      mode: "buy",
      split: false,
      marketCondition: "HOT",
      slippage: 1.5,
    });

    expect(assessment.quality_score).toBeLessThan(35);
    expect(assessment.stance).toBe("avoid");
    expect(assessment.size_multiplier).toBeLessThanOrEqual(0.75);
  });

  it("ranks wallets by remembered execution quality", () => {
    recordExecutionQuality({
      walletAddress: "walletA",
      provider: "auto",
      mode: "entry",
      split: false,
      marketCondition: "NORMAL",
      slippage: 0.5,
      success: true,
      latencyMs: 900,
    });
    recordExecutionQuality({
      walletAddress: "walletA",
      provider: "auto",
      mode: "entry",
      split: false,
      marketCondition: "NORMAL",
      slippage: 0.5,
      success: true,
      latencyMs: 1000,
    });
    recordExecutionQuality({
      walletAddress: "walletB",
      provider: "auto",
      mode: "entry",
      split: false,
      marketCondition: "NORMAL",
      slippage: 0.5,
      success: false,
      latencyMs: 3000,
    });
    recordExecutionQuality({
      walletAddress: "walletB",
      provider: "auto",
      mode: "entry",
      split: false,
      marketCondition: "NORMAL",
      slippage: 0.5,
      success: false,
      latencyMs: 3200,
    });

    const ranked = rankWalletExecutionCandidates(
      [{ address: "walletB" }, { address: "walletA" }],
      { provider: "auto", mode: "entry", split: false, marketCondition: "NORMAL", slippage: 0.5 }
    );

    expect(ranked[0].address).toBe("walletA");
    expect(ranked[1].address).toBe("walletB");
  });

  it("decays stale execution quality over time", () => {
    recordExecutionQuality({
      walletAddress: "walletC",
      provider: "jito",
      mode: "sell",
      split: false,
      marketCondition: "HOT",
      slippage: 1,
      success: true,
      latencyMs: 1500,
    });
    const start = Date.now();

    const fresh = getExecutionQualityAssessment({
      walletAddress: "walletC",
      provider: "jito",
      mode: "sell",
      split: false,
      marketCondition: "HOT",
      slippage: 1,
      nowMs: start,
    });
    const stale = getExecutionQualityAssessment({
      walletAddress: "walletC",
      provider: "jito",
      mode: "sell",
      split: false,
      marketCondition: "HOT",
      slippage: 1,
      nowMs: start + (9 * 24 * 60 * 60 * 1000),
    });

    expect(stale.decay_factor).toBeLessThan(1);
    expect(stale.quality_score).toBeLessThanOrEqual(fresh.quality_score);
  });
});
