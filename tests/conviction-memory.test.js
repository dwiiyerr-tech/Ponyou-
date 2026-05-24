import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetConvictionMemoryForTests,
  deriveSignalScore,
  getCoinConviction,
  getNarrativeConviction,
  recordCoinObservation,
  recordObservationOutcomes,
  recordTradeConvictionOutcome,
} from "../conviction-memory.js";

beforeEach(() => {
  _resetConvictionMemoryForTests();
});

describe("conviction memory", () => {
  it("builds conviction from repeated clean observations", async () => {
    for (let i = 0; i < 3; i++) {
      await recordCoinObservation({
        mint: "mintA",
        symbol: "AAA",
        passed: true,
        rug_score: 8,
        flags: [],
        momentum_score: 40,
        market_condition: "HOT",
        kelly: { effective_fraction: 0.25, should_skip: false },
      }, { minIntervalMs: 0 });
    }

    const conviction = getCoinConviction("mintA");
    expect(conviction.observation_count).toBe(3);
    expect(conviction.conviction_score).toBeGreaterThan(40);
    expect(conviction.confidence_score).toBeGreaterThan(20);
  });

  it("upgrades conviction when observations become gems and profitable trades", async () => {
    for (let i = 0; i < 3; i++) {
      await recordCoinObservation({
        mint: "mintB",
        symbol: "BBB",
        passed: true,
        rug_score: 5,
        flags: [],
        momentum_score: 48,
        market_condition: "HOT",
        kelly: { effective_fraction: 0.3, should_skip: false },
      }, { minIntervalMs: 0 });
    }

    recordObservationOutcomes([{ mint: "mintB", symbol: "BBB", performance: "GEM" }]);
    recordTradeConvictionOutcome({ mint: "mintB", symbol: "BBB", pnl_pct: 65, exit_reason: "ROI TP" });

    const conviction = getCoinConviction("mintB");
    expect(conviction.gem_count).toBe(1);
    expect(conviction.win_count).toBe(1);
    expect(conviction.conviction_score).toBeGreaterThan(70);
    expect(conviction.stance).toBe("strong");
  });

  it("cuts conviction when the coin repeatedly looks bad", async () => {
    await recordCoinObservation({
      mint: "mintC",
      symbol: "CCC",
      passed: false,
      rug_score: 38,
      flags: ["holder risk", "kelly reject"],
      momentum_score: 0,
      market_condition: "DEAD",
      kelly: { effective_fraction: 0, should_skip: true },
    }, { minIntervalMs: 0 });

    recordObservationOutcomes([{ mint: "mintC", symbol: "CCC", performance: "TRASH" }]);
    recordTradeConvictionOutcome({ mint: "mintC", symbol: "CCC", pnl_pct: -42, exit_reason: "Stop Loss" });

    const conviction = getCoinConviction("mintC");
    expect(conviction.trash_count).toBe(1);
    expect(conviction.loss_count).toBe(1);
    expect(conviction.conviction_score).toBeLessThan(30);
    expect(conviction.stance).toBe("avoid");
  });

  it("derives higher signal scores for cleaner setups", () => {
    const clean = deriveSignalScore({
      passed: true,
      rug_score: 5,
      flags: [],
      momentum_score: 32,
      market_condition: "HOT",
      kelly: { effective_fraction: 0.2, should_skip: false },
    });
    const dirty = deriveSignalScore({
      passed: false,
      rug_score: 42,
      flags: ["a", "b"],
      momentum_score: 0,
      market_condition: "DEAD",
      kelly: { effective_fraction: 0, should_skip: true },
    });

    expect(clean).toBeGreaterThan(dirty);
  });

  it("builds narrative cluster conviction and lets a coin inherit it", async () => {
    for (let i = 0; i < 3; i++) {
      await recordCoinObservation({
        mint: `ai-${i}`,
        symbol: `AI${i}`,
        name: "AI Agent Coin",
        passed: true,
        rug_score: 6,
        flags: [],
        momentum_score: 36,
        market_condition: "HOT",
        kelly: { effective_fraction: 0.25, should_skip: false },
      }, { minIntervalMs: 0 });
      recordObservationOutcomes([{ mint: `ai-${i}`, symbol: `AI${i}`, performance: "GEM" }]);
      recordTradeConvictionOutcome({ mint: `ai-${i}`, symbol: `AI${i}`, pnl_pct: 40, exit_reason: "TP" });
    }

    const narrative = getNarrativeConviction("AI");
    const inherited = getCoinConviction("new-ai-coin", { symbol: "AGENTX", name: "New AI Agent" });

    expect(narrative.conviction_score).toBeGreaterThan(60);
    expect(inherited.narrative_cluster?.narrative).toBe("AI");
    expect(inherited.conviction_score).toBeGreaterThan(0);
  });

  it("decays stale conviction over time", async () => {
    const start = Date.UTC(2026, 0, 1);
    const realNow = Date.now;
    Date.now = () => start;
    try {
      await recordCoinObservation({
        mint: "mintDecay",
        symbol: "DECAY",
        passed: true,
        rug_score: 4,
        flags: [],
        momentum_score: 45,
        market_condition: "HOT",
        kelly: { effective_fraction: 0.3, should_skip: false },
      }, { minIntervalMs: 0 });
      recordObservationOutcomes([{ mint: "mintDecay", symbol: "DECAY", performance: "GEM" }]);
      recordTradeConvictionOutcome({ mint: "mintDecay", symbol: "DECAY", pnl_pct: 55, exit_reason: "TP" });
    } finally {
      Date.now = realNow;
    }

    const fresh = getCoinConviction("mintDecay", null, { nowMs: start });
    const stale = getCoinConviction("mintDecay", null, { nowMs: start + (10 * 24 * 60 * 60 * 1000) });

    expect(stale.conviction_score).toBeLessThan(fresh.conviction_score);
    expect(stale.decay_factor).toBeLessThan(1);
  });
});
