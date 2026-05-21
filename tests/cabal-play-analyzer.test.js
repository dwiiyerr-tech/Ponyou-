import { describe, expect, it } from "vitest";
import {
  analyzeCabalPlay,
  CabalAgentAction,
  CabalRiskLevel,
  CabalType,
} from "../tools/cabal-play-analyzer.js";

describe("CabalPlayAnalyzer", () => {
  it("detects GROUP_CABAL from same-funder related wallet accumulation", () => {
    const result = analyzeCabalPlay({
      wallets: [
        { address: "A", fundedBy: "seed", relationGroupId: "cluster-a", lastAction: "buy", pct: 2.5 },
        { address: "B", fundedBy: "seed", relationGroupId: "cluster-a", lastAction: "buy", pct: 2.2 },
        { address: "C", fundedBy: "seed", relationGroupId: "cluster-a", lastAction: "buy", pct: 2.1 },
        { address: "D", fundedBy: "seed", relationGroupId: "cluster-a", lastAction: "buy", pct: 1.9 },
      ],
      coordinatedBuyWindowMinutes: 4,
      bundleBuyersPct: 32,
      freshFundedWallets: 6,
      top10HolderConcentration: 48,
      pricePumpPercent: 22,
    });

    expect(result.cabalType).toBe(CabalType.GROUP_CABAL);
    expect(result.action).toBe(CabalAgentAction.REQUIRE_CONFIRMATION);
    expect(result.riskLevel).toBe(CabalRiskLevel.HIGH);
    expect(result.patternSignals.groupCabal).toBe(true);
    expect(result.reasons.join(" ")).toContain("same funder");
  });

  it("detects SOLO_CABAL when one dominant wallet controls the setup", () => {
    const result = analyzeCabalPlay({
      maxHolderPct: 12,
      knownCabalWallets: 1,
      dominantWalletNetFlowSol: 3.4,
      top10HolderConcentration: 34,
      pricePumpPercent: 18,
    });

    expect(result.cabalType).toBe(CabalType.SOLO_CABAL);
    expect(result.action).toBe(CabalAgentAction.WATCH_DOMINANT_WALLET);
    expect(result.riskLevel).toBe(CabalRiskLevel.MEDIUM);
    expect(result.cabalScore).toBeGreaterThanOrEqual(55);
  });

  it("detects CONFLICT_CABAL when accumulation and exits happen together", () => {
    const result = analyzeCabalPlay({
      coordinatedBuyWallets: 4,
      coordinatedSellWallets: 4,
      smartWalletBuys: 2,
      smartWalletSells: 2,
      buyPressurePercent: 55,
      sellPressurePercent: 50,
      pricePumpPercent: 52,
    });

    expect(result.cabalType).toBe(CabalType.CONFLICT_CABAL);
    expect(result.action).toBe(CabalAgentAction.WAIT_FOR_RESOLUTION);
    expect(result.riskLevel).toBe(CabalRiskLevel.HIGH);
    expect(result.patternSignals.conflictCabal).toBe(true);
  });

  it("routes post-pump insider exits to DISTRIBUTION_RISK", () => {
    const result = analyzeCabalPlay({
      tokenAgeMinutes: 74,
      pricePumpPercent: 140,
      devWalletNotHolding: true,
      coordinatedSellWallets: 5,
      coordinatedSellWindowMinutes: 7,
      top10HolderConcentration: 54,
      sellPressurePercent: 70,
      smartWalletSells: 3,
    });

    expect(result.cabalType).toBe(CabalType.DISTRIBUTION_RISK);
    expect(result.action).toBe(CabalAgentAction.BLOCK_ENTRY);
    expect(result.riskLevel).toBe(CabalRiskLevel.CRITICAL);
    expect(result.cabalScore).toBeGreaterThanOrEqual(90);
  });

  it("detects FOMO_RISK when retail chase lacks cabal or organic support", () => {
    const result = analyzeCabalPlay({
      pricePumpPercent: 85,
      socialHypeScore: 92,
      retailBuyCount: 180,
      buyPressurePercent: 78,
      uniqueWallets: 300,
      volumeUsd: 160_000,
      organicCommunityScore: 42,
      coordinatedBuyWallets: 1,
      smartWalletBuys: 0,
    });

    expect(result.cabalType).toBe(CabalType.FOMO_RISK);
    expect(result.action).toBe(CabalAgentAction.WAIT_FOR_COOLDOWN);
    expect(result.patternSignals.fomoRisk).toBe(true);
    expect(result.reasons.join(" ")).toContain("Retail flow");
  });

  it("returns NONE for clean mixed wallet data below routing thresholds", () => {
    const result = analyzeCabalPlay({
      wallets: [
        { address: "A", fundedBy: "seed-a", relationGroupId: "a", lastAction: "buy", pct: 1.8 },
        { address: "B", fundedBy: "seed-b", relationGroupId: "b", lastAction: "hold", pct: 1.5 },
        { address: "C", fundedBy: "seed-c", relationGroupId: "c", lastAction: "hold", pct: 1.2 },
      ],
      pricePumpPercent: 12,
      top10HolderConcentration: 18,
      organicCommunityScore: 86,
      socialHypeScore: 40,
      retailBuyCount: 15,
    });

    expect(result.cabalType).toBe(CabalType.NONE);
    expect(result.riskLevel).toBe(CabalRiskLevel.LOW);
    expect(result.action).toBe(CabalAgentAction.WATCH_ONLY);
    expect(result.isDirectBuySignal).toBe(false);
  });

  it("handles missing input without throwing", () => {
    const result = analyzeCabalPlay();

    expect(result.cabalType).toBe(CabalType.NONE);
    expect(result.action).toBe(CabalAgentAction.WATCH_ONLY);
    expect(result.confidence).toBe(0.3);
    expect(result.reasons[0]).toContain("No wallet/cabal signals supplied");
  });

  it("never exposes trading action names from the action enum or result", () => {
    const result = analyzeCabalPlay({
      pricePumpPercent: 120,
      devWalletNotHolding: true,
      coordinatedSellWallets: 4,
      coordinatedSellWindowMinutes: 5,
      sellPressurePercent: 68,
      top10HolderConcentration: 45,
    });
    const allActionNames = Object.values(CabalAgentAction).join(" ");

    expect(allActionNames).not.toMatch(/\b(BUY|SELL)\b/);
    expect(result.action).not.toMatch(/\b(BUY|SELL)\b/);
    expect(result.isDirectBuySignal).toBe(false);
  });
});
