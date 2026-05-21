import { describe, expect, it } from "vitest";
import {
  analyzeDayPhase,
  DayPhase,
  isDayPhaseTradeUnlocked,
  WatchlistStatus,
} from "../tools/day-phase-analyzer.js";

describe("DayPhaseAnalyzer", () => {
  it("balance gate blocks when wallet < 1 SOL", () => {
    const result = analyzeDayPhase({ walletBalanceSol: 0.5 });
    expect(result.isUnlocked).toBe(false);
    expect(result.watchlistStatus).toBe(WatchlistStatus.SKIP);
    expect(result.score).toBe(0);
    expect(result.executionPlan).toBeNull();
    expect(result.isDirectBuySignal).toBe(false);
    expect(result.reasons[0]).toMatch(/Balance gate locked/);
  });

  it("isDayPhaseTradeUnlocked returns true at exactly 1 SOL", () => {
    expect(isDayPhaseTradeUnlocked(1)).toBe(true);
    expect(isDayPhaseTradeUnlocked(0.999)).toBe(false);
    expect(isDayPhaseTradeUnlocked(5)).toBe(true);
  });

  it("STRONG score: perfect sideways — 60% dip, 4 days, $2M FDV, social 80, uptick volume", () => {
    const result = analyzeDayPhase({
      walletBalanceSol: 2,
      currentPrice: 0.4,
      athPrice: 1.0,
      sidewaysDays: 4,
      fdvUsd: 2_000_000,
      socialScore: 80,
      volumeToday: 120_000,
      volumeYesterday: 100_000,
      volumeDayBefore: 90_000,
      entryDayOfWeek: "Friday",
    });

    expect(result.isUnlocked).toBe(true);
    expect(result.watchlistStatus).toBe(WatchlistStatus.STRONG);
    expect(result.score).toBe(100);
    expect(result.dayPhase).toBe(DayPhase.COOLDOWN_SIDEWAYS);
    expect(result.scoreBreakdown.dipDepth).toBe(25);
    expect(result.scoreBreakdown.sidewaysDuration).toBe(20);
    expect(result.scoreBreakdown.fdv).toBe(20);
    expect(result.scoreBreakdown.narrativeAlive).toBe(20);
    expect(result.scoreBreakdown.volumeTrend).toBe(15);
    expect(result.isDirectBuySignal).toBe(false);
  });

  it("dip 50% boundary scores 25 pts", () => {
    const result = analyzeDayPhase({
      walletBalanceSol: 2,
      currentPrice: 0.5,
      athPrice: 1.0,
      sidewaysDays: 0,
      fdvUsd: 0,
      socialScore: 0,
    });
    expect(result.scoreBreakdown.dipDepth).toBe(25);
  });

  it("hype phase: shallow dip, no sideways", () => {
    const result = analyzeDayPhase({
      walletBalanceSol: 2,
      currentPrice: 0.9,
      athPrice: 1.0,
      sidewaysDays: 0,
      fdvUsd: 500_000,
      socialScore: 30,
      volumeToday: 500_000,
      volumeYesterday: 100_000,
    });

    expect(result.dayPhase).toBe(DayPhase.HYPE);
    expect(result.watchlistStatus).toBe(WatchlistStatus.SKIP);
    expect(result.executionPlan).toBeNull();
    expect(result.isDirectBuySignal).toBe(false);
  });

  it("revival/death: 92% dip, 14 days stale, low FDV", () => {
    const result = analyzeDayPhase({
      walletBalanceSol: 2,
      currentPrice: 0.08,
      athPrice: 1.0,
      sidewaysDays: 14,
      fdvUsd: 100_000,
      socialScore: 10,
      volumeToday: 1000,
      volumeYesterday: 5000,
    });

    expect(result.dayPhase).toBe(DayPhase.REVIVAL_DEATH);
    expect(result.watchlistStatus).toBe(WatchlistStatus.SKIP);
    expect(result.scoreBreakdown.dipDepth).toBe(0);
    expect(result.scoreBreakdown.sidewaysDuration).toBe(0);
  });

  it("MEDIUM score: 45% dip, 1 day sideways, $1.2M FDV, social 60, stabilizing volume", () => {
    const result = analyzeDayPhase({
      walletBalanceSol: 1.5,
      currentPrice: 0.55,
      athPrice: 1.0,
      sidewaysDays: 1,
      fdvUsd: 1_200_000,
      socialScore: 60,
      volumeToday: 95_000,
      volumeYesterday: 100_000,
      volumeDayBefore: 110_000,
      entryDayOfWeek: "Monday",
    });

    expect(result.watchlistStatus).toBe(WatchlistStatus.MEDIUM);
    expect(result.scoreBreakdown.dipDepth).toBe(15);
    expect(result.scoreBreakdown.sidewaysDuration).toBe(5);
    expect(result.scoreBreakdown.fdv).toBe(20);
    expect(result.scoreBreakdown.narrativeAlive).toBe(10);
    expect(result.scoreBreakdown.volumeTrend).toBe(10);
    expect(result.score).toBe(60);
    expect(result.executionPlan).not.toBeNull();
    expect(result.executionPlan.weekendBias).toBe(true);
    expect(result.executionPlan.dcaTranches).toHaveLength(3);
  });

  it("ExecutionPlan weekend: entry on Saturday uses weekend tranche strategy", () => {
    const result = analyzeDayPhase({
      walletBalanceSol: 2,
      currentPrice: 0.4,
      athPrice: 1.0,
      sidewaysDays: 4,
      fdvUsd: 2_000_000,
      socialScore: 80,
      volumeToday: 120_000,
      volumeYesterday: 100_000,
      entryDayOfWeek: "Saturday",
    });

    expect(result.executionPlan.weekendBias).toBe(false);
    expect(result.executionPlan.dcaTranches).toHaveLength(2);
    expect(result.executionPlan.dcaTranches[0]).toMatch(/weekend/);
  });

  it("ExecutionPlan shape: tp1=40%, tp2=70%, maxHold=7d, invalidation=15%", () => {
    const result = analyzeDayPhase({
      walletBalanceSol: 2,
      currentPrice: 0.4,
      athPrice: 1.0,
      sidewaysDays: 4,
      fdvUsd: 2_000_000,
      socialScore: 80,
      volumeToday: 120_000,
      volumeYesterday: 100_000,
    });

    const plan = result.executionPlan;
    expect(plan).not.toBeNull();
    expect(plan.tp1Percent).toBe(40);
    expect(plan.tp2Percent).toBe(70);
    expect(plan.maxHoldDays).toBe(7);
    expect(plan.invalidationDropPercent).toBe(15);
    expect(plan.tp1ExitPercent).toBe(40);
    expect(plan.tp2ExitPercent).toBe(70);
  });

  it("missing ATH/price gives 0 dip pts, no throw", () => {
    const result = analyzeDayPhase({ walletBalanceSol: 2 });
    expect(result.scoreBreakdown.dipDepth).toBe(0);
    expect(result.isDirectBuySignal).toBe(false);
    expect(result.isUnlocked).toBe(true);
  });

  it("isDirectBuySignal always false regardless of input", () => {
    expect(analyzeDayPhase({ walletBalanceSol: 100, currentPrice: 0.4, athPrice: 1, sidewaysDays: 4, fdvUsd: 5_000_000, socialScore: 100, volumeToday: 200_000, volumeYesterday: 100_000 }).isDirectBuySignal).toBe(false);
    expect(analyzeDayPhase().isDirectBuySignal).toBe(false);
    expect(analyzeDayPhase({ walletBalanceSol: 0 }).isDirectBuySignal).toBe(false);
  });
});
