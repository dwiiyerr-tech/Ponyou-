import { describe, expect, it } from "vitest";
import {
  analyzeDexVisibilityRisk,
  RiskStatus,
} from "../tools/dex-visibility-risk-analyzer.js";
import { tools } from "../tools/definitions.js";

describe("DexVisibilityRiskAnalyzer", () => {
  it("classifies early low-volume organic visibility as POSITIVE", () => {
    const result = analyzeDexVisibilityRisk({
      tokenAgeMinutes: 8,
      visibilitySignalAgeMinutes: 3,
      hasDexPaid: true,
      pricePumpPercent: 18,
      volumeUsd: 12_000,
      uniqueWallets: 80,
      organicCommunityScore: 86,
      narrativeScore: 84,
      top10HolderConcentration: 12,
      devWalletNotHolding: false,
    });

    expect(result.riskStatus).toBe(RiskStatus.POSITIVE);
    expect(result.isBullishSignal).toBe(true);
    expect(result.isDistributionTrap).toBe(false);
    expect(result.reasons.join(" ")).toContain("Very early launch");
  });

  it("classifies mixed visibility signals as NEUTRAL", () => {
    const result = analyzeDexVisibilityRisk({
      tokenAgeMinutes: 24,
      visibilitySignalAgeMinutes: 18,
      hasAds: true,
      pricePumpPercent: 32,
      volumeUsd: 42_000,
      uniqueWallets: 35,
      organicCommunityScore: 58,
      narrativeScore: 62,
      top10HolderConcentration: 18,
    });

    expect(result.riskStatus).toBe(RiskStatus.NEUTRAL);
    expect(result.isBullishSignal).toBe(false);
    expect(result.isDistributionTrap).toBe(false);
  });

  it("classifies post-pump holder concentration as DANGER", () => {
    const result = analyzeDexVisibilityRisk({
      tokenAgeMinutes: 40,
      visibilitySignalAgeMinutes: 6,
      hasBoost: true,
      pricePumpPercent: 88,
      volumeUsd: 90_000,
      uniqueWallets: 70,
      organicCommunityScore: 44,
      narrativeScore: 55,
      top10HolderConcentration: 46,
    });

    expect(result.riskStatus).toBe(RiskStatus.DANGER);
    expect(result.isDistributionTrap).toBe(true);
    expect(result.reasons.join(" ")).toContain("forced DANGER");
  });

  it("classifies all core danger flags as HIGH_RISK", () => {
    const result = analyzeDexVisibilityRisk({
      tokenAgeMinutes: 70,
      visibilitySignalAgeMinutes: 5,
      hasDexPaid: true,
      hasAds: true,
      pricePumpPercent: 140,
      volumeUsd: 220_000,
      uniqueWallets: 18,
      organicCommunityScore: 22,
      narrativeScore: 35,
      top10HolderConcentration: 54,
      devWalletNotHolding: true,
    });

    expect(result.riskStatus).toBe(RiskStatus.HIGH_RISK);
    expect(result.visibilityRiskScore).toBeGreaterThanOrEqual(90);
    expect(result.isDistributionTrap).toBe(true);
  });

  it("defaults invalid input to NEUTRAL without throwing", () => {
    const result = analyzeDexVisibilityRisk({});

    expect(result.riskStatus).toBe(RiskStatus.NEUTRAL);
    expect(result.visibilityRiskScore).toBe(50);
    expect(result.reasons[0]).toContain("tokenAgeMinutes missing");
  });
});


describe("analysis tool registry", () => {
  const analysisToolNames = [
    "analyze_dex_visibility_risk",
    "analyze_three_candle_confirmation",
    "analyze_cabal_play",
    "process_wallet_ping",
    "analyze_day_phase",
  ];

  it("exposes completed analysis modules to the agent tool list", () => {
    const registered = new Set(tools.map(tool => tool.function.name));

    for (const name of analysisToolNames) {
      expect(registered.has(name)).toBe(true);
    }
  });
});
