import { describe, expect, it } from "vitest";
import {
  detectRelatedWallets,
  PingSeverity,
  processWalletPing,
  scoreWalletQuality,
  WalletEventType,
  WalletPingAction,
  WalletQualityLevel,
} from "../tools/wallet-ping-agent.js";

describe("WalletPingAgent", () => {
  it("isDirectBuySignal is always false regardless of inputs", () => {
    const eliteInput = {
      event: WalletEventType.BUY,
      stats: { winRate30d: 0.8, profitFactor: 4, memecoinWinRate: 0.7, earlyEntryPrecision: 1, positionSizeStability: 1, holdingDiscipline: 1, walletAgeDays: 365 },
      buyerRankInPool: 1,
      totalBuyersInPool: 50,
      positionSizeSol: 10,
      avgPositionSizeSol: 2,
    };
    const result = processWalletPing(eliteInput);
    expect(result.isDirectBuySignal).toBe(false);

    const emptyResult = processWalletPing();
    expect(emptyResult.isDirectBuySignal).toBe(false);
  });

  it("elite lead entry triggers NOTIFY + ROUTE_TO_ANALYZER at HIGH severity", () => {
    const result = processWalletPing({
      event: WalletEventType.BUY,
      stats: { winRate30d: 0.7, profitFactor: 3.5, memecoinWinRate: 0.65, earlyEntryPrecision: 0.9, positionSizeStability: 0.8, holdingDiscipline: 0.9, walletAgeDays: 200 },
      buyerRankInPool: 5,
      totalBuyersInPool: 40,
      positionSizeSol: 1,
      avgPositionSizeSol: 1,
    });

    expect(result.qualityLevel).toBe(WalletQualityLevel.ELITE);
    expect(result.severity).toBe(PingSeverity.HIGH);
    expect(result.actions).toContain(WalletPingAction.NOTIFY);
    expect(result.actions).toContain(WalletPingAction.ROUTE_TO_ANALYZER);
    expect(result.reasons.join(" ")).toMatch(/top-10/);
  });

  it("wash trade filter suppresses signal and returns LOG only", () => {
    const result = processWalletPing({
      event: WalletEventType.BUY,
      stats: { winRate30d: 0.8, profitFactor: 4, memecoinWinRate: 0.7, walletAgeDays: 300 },
      recentWalletEvents: 6,
    });

    expect(result.severity).toBe(PingSeverity.LOW);
    expect(result.actions).toEqual([WalletPingAction.LOG]);
    expect(result.reasons[0]).toMatch(/Wash trade/);
    expect(result.riskFlags[0].type).toBe("WASH_TRADE");
    expect(result.isDirectBuySignal).toBe(false);
  });

  it("blacklisted token suppresses signal regardless of wallet quality", () => {
    const result = processWalletPing({
      event: WalletEventType.BUY,
      tokenMint: "BADTOKEN123",
      blacklistedTokens: ["BADTOKEN123", "OTHERTOKEN"],
      stats: { winRate30d: 0.8, profitFactor: 4, walletAgeDays: 300 },
    });

    expect(result.severity).toBe(PingSeverity.LOW);
    expect(result.actions).toEqual([WalletPingAction.LOG]);
    expect(result.reasons[0]).toMatch(/blacklist/);
    expect(result.riskFlags[0].type).toBe("BLACKLISTED_TOKEN");
  });

  it("insider lineage sets CRITICAL severity and FLAG_WALLET", () => {
    const result = processWalletPing({
      event: WalletEventType.BUY,
      creatorWallet: "CREATOR_ADDR",
      stats: { winRate30d: 0.5, profitFactor: 2, walletAgeDays: 90, fundedBy: "CREATOR_ADDR" },
    });

    expect(result.severity).toBe(PingSeverity.CRITICAL);
    expect(result.actions).toContain(WalletPingAction.FLAG_WALLET);
    expect(result.actions).toContain(WalletPingAction.NOTIFY);
    expect(result.riskFlags.some(f => f.type === "INSIDER_LINEAGE")).toBe(true);
    expect(result.isDirectBuySignal).toBe(false);
  });

  it("3+ related wallets adds ROUTE_TO_ANALYZER via cluster expansion", () => {
    const result = processWalletPing({
      event: WalletEventType.BUY,
      stats: { walletAgeDays: 60 },
      relatedWallets: [
        { address: "A", relationship: "same_funder", fundingAmountSol: 0.5 },
        { address: "B", relationship: "same_funder", fundingAmountSol: 0.3 },
        { address: "C", relationship: "same_cluster", fundingAmountSol: 0.2 },
      ],
    });

    expect(result.actions).toContain(WalletPingAction.ROUTE_TO_ANALYZER);
    expect(result.reasons.join(" ")).toMatch(/related wallets/);
    expect(result.relatedWallets).toHaveLength(3);
  });

  it("related wallets below 0.1 SOL threshold are filtered out", () => {
    const related = detectRelatedWallets({
      relatedWallets: [
        { address: "A", relationship: "same_funder", fundingAmountSol: 0.5 },
        { address: "B", relationship: "same_cluster", fundingAmountSol: 0.05 },
        { address: "C", relationship: "same_cluster", fundingAmountSol: 0.0 },
      ],
    });
    expect(related).toHaveLength(1);
    expect(related[0].address).toBe("A");
  });

  it("rugger creating LP sets CRITICAL + FLAG_WALLET", () => {
    const result = processWalletPing({
      event: WalletEventType.LP_ADD,
      stats: { isKnownRugger: true, walletAgeDays: 20 },
    });

    expect(result.severity).toBe(PingSeverity.CRITICAL);
    expect(result.actions).toContain(WalletPingAction.FLAG_WALLET);
    expect(result.riskFlags.some(f => f.type === "RUGGER_ACTIVITY")).toBe(true);
    expect(result.isDirectBuySignal).toBe(false);
  });

  it("anti-fomo guard downgrades severity after 200%+ pump", () => {
    const result = processWalletPing({
      event: WalletEventType.BUY,
      pricePumpPercent: 250,
      stats: { winRate30d: 0.7, profitFactor: 3.5, memecoinWinRate: 0.65, earlyEntryPrecision: 0.9, positionSizeStability: 0.8, holdingDiscipline: 0.9, walletAgeDays: 200 },
      buyerRankInPool: 5,
      totalBuyersInPool: 40,
    });

    // Elite lead entry would set HIGH, anti-fomo should downgrade to MEDIUM
    expect(result.severity).toBe(PingSeverity.MEDIUM);
    expect(result.reasons.join(" ")).toMatch(/200/);
  });

  it("scoreWalletQuality returns correct level and clamped score", () => {
    const elite = scoreWalletQuality({ winRate30d: 0.7, profitFactor: 3.5, memecoinWinRate: 0.65, earlyEntryPrecision: 0.95, positionSizeStability: 0.9, holdingDiscipline: 0.9, walletAgeDays: 200 });
    expect(elite.qualityLevel).toBe(WalletQualityLevel.ELITE);
    expect(elite.qualityScore).toBeGreaterThanOrEqual(80);
    expect(elite.qualityScore).toBeLessThanOrEqual(100);

    const poor = scoreWalletQuality({ winRate30d: 0.1, profitFactor: 0.5, memecoinWinRate: 0.1, earlyEntryPrecision: 0, positionSizeStability: 0, holdingDiscipline: 0, walletAgeDays: 5, isKnownRugger: true });
    expect(poor.qualityLevel).toBe(WalletQualityLevel.POOR);
    expect(poor.qualityScore).toBeGreaterThanOrEqual(0);

    const missing = scoreWalletQuality({});
    expect(missing.qualityScore).toBeGreaterThanOrEqual(0);
    expect(missing.qualityScore).toBeLessThanOrEqual(100);
    expect(Object.values(WalletQualityLevel)).toContain(missing.qualityLevel);
  });
});
