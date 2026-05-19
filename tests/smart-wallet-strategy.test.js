import { describe, expect, it } from "vitest";
import {
  evaluateSmartWalletCandidate,
  getAdaptiveSmartWalletContext,
  selectSmartWalletCandidates,
} from "../smart-wallet-strategy.js";

function makeCandidate(overrides = {}) {
  return {
    address: "wallet123",
    stats: {
      completed_trades: 16,
      winrate: 0.78,
      realized_pnl_sol: 2.4,
      avg_hold_seconds: 600,
      unique_tokens: 10,
    },
    ...overrides,
  };
}

describe("getAdaptiveSmartWalletContext", () => {
  it("becomes stricter when observation data is still thin", () => {
    const thin = getAdaptiveSmartWalletContext({
      marketCondition: "NORMAL",
      observationSummary: { reviewed: 4, gems: 1, trash: 1, rugs: 0, gem_ratio: 0.25, trash_ratio: 0.25, confidence: 0.2 },
    });
    const rich = getAdaptiveSmartWalletContext({
      marketCondition: "NORMAL",
      observationSummary: { reviewed: 50, gems: 16, trash: 6, rugs: 2, gem_ratio: 0.32, trash_ratio: 0.16, confidence: 1 },
    });

    expect(thin.profile.minScore).toBeGreaterThan(rich.profile.minScore);
    expect(thin.enoughData).toBe(false);
    expect(rich.enoughData).toBe(true);
  });
});

describe("evaluateSmartWalletCandidate", () => {
  it("rejects low-information wallets to avoid FOMO", () => {
    const context = getAdaptiveSmartWalletContext({
      marketCondition: "NORMAL",
      observationSummary: { reviewed: 5, gems: 0, trash: 2, rugs: 1, gem_ratio: 0, trash_ratio: 0.6, confidence: 0.25 },
    });
    const result = evaluateSmartWalletCandidate(makeCandidate({
      stats: {
        completed_trades: 5,
        winrate: 0.92,
        realized_pnl_sol: 1.1,
        avg_hold_seconds: 30,
        unique_tokens: 5,
      },
    }), context);

    expect(result.selected).toBe(false);
    expect(result.follow_mode).toBe("shadow");
    expect(result.reasons.join(" ")).toMatch(/belum cukup|MEV|trash/i);
  });

  it("allows active follow mode for disciplined wallets when data is rich", () => {
    const context = getAdaptiveSmartWalletContext({
      marketCondition: "HOT",
      observationSummary: { reviewed: 60, gems: 22, trash: 5, rugs: 1, gem_ratio: 0.367, trash_ratio: 0.1, confidence: 1 },
    });
    const result = evaluateSmartWalletCandidate(makeCandidate(), context);

    expect(result.selected).toBe(true);
    expect(["probe", "active"]).toContain(result.follow_mode);
    expect(result.score).toBeGreaterThanOrEqual(context.profile.minScore);
    expect(result.size_multiplier).toBeGreaterThan(0);
  });

  it("skips new follow actions completely in DEAD market", () => {
    const result = evaluateSmartWalletCandidate(makeCandidate(), {
      marketCondition: "DEAD",
      observationSummary: { reviewed: 80, gems: 10, trash: 20, rugs: 10, gem_ratio: 0.125, trash_ratio: 0.375, confidence: 1 },
      profile: getAdaptiveSmartWalletContext({
        marketCondition: "DEAD",
        observationSummary: { reviewed: 80, gems: 10, trash: 20, rugs: 10, gem_ratio: 0.125, trash_ratio: 0.375, confidence: 1 },
      }).profile,
    });

    expect(result.selected).toBe(false);
    expect(result.follow_mode).toBe("skip");
    expect(result.size_multiplier).toBe(0);
  });
});

describe("selectSmartWalletCandidates", () => {
  it("sorts stronger candidates first by adaptive score", () => {
    const context = getAdaptiveSmartWalletContext({
      marketCondition: "HOT",
      observationSummary: { reviewed: 50, gems: 18, trash: 4, rugs: 1, gem_ratio: 0.36, trash_ratio: 0.1, confidence: 1 },
    });
    const ranked = selectSmartWalletCandidates([
      makeCandidate({ address: "low", stats: { completed_trades: 8, winrate: 0.66, realized_pnl_sol: 0.7, avg_hold_seconds: 480, unique_tokens: 8 } }),
      makeCandidate({ address: "high" }),
    ], context);

    expect(ranked[0].address).toBe("high");
    expect(ranked[0].selection.score).toBeGreaterThanOrEqual(ranked[1].selection.score);
  });
});
