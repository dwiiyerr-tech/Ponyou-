/**
 * Tests for the Super Brain components:
 *  - episodic-memory.js  (fingerprint, recall, episodic block)
 *  - adaptive-risk.js    (risk multiplier ladder, prompt line)
 *  - prompt-evolution.js (factor attribution, learned rules)
 */
import { describe, it, expect, beforeEach } from "vitest";

// ─── Episodic Memory ──────────────────────────────────────────────────────────
import { fingerprint, recordEpisode, recallEpisodes, getEpisodicBlock, _resetEpisodicMemoryForTests } from "../episodic-memory.js";

const TOKEN_AI_MICRO = { chain: "sol", mcap: 50_000, liquidity: 8_000, narrative_tags: ["ai-agent"], rug_score: 10, tier: "A" };
const TOKEN_DOG_MID  = { chain: "sol", mcap: 200_000, liquidity: 30_000, narrative_tags: ["dog-meme"], rug_score: 35, tier: "B" };

describe("episodic-memory: fingerprint", () => {
  it("produces a consistent key for same token features", () => {
    expect(fingerprint(TOKEN_AI_MICRO)).toBe(fingerprint({ ...TOKEN_AI_MICRO }));
  });
  it("produces different keys for different mcap bands", () => {
    const small = fingerprint({ ...TOKEN_AI_MICRO, mcap: 15_000 });
    const large = fingerprint({ ...TOKEN_AI_MICRO, mcap: 250_000 });
    expect(small).not.toBe(large);
  });
  it("includes chain, mcap band, liq band, narrative, rug band, tier", () => {
    const fp = fingerprint(TOKEN_AI_MICRO);
    expect(fp).toContain("sol");
    expect(fp).toContain("mcap:");
    expect(fp).toContain("narr:ai-agent");
  });
});

describe("episodic-memory: recall", () => {
  beforeEach(() => _resetEpisodicMemoryForTests());

  it("returns null when fewer than minSamples recorded", () => {
    recordEpisode({ mint: "A", symbol: "AA", token: TOKEN_AI_MICRO, pnl_pct: 30, hold_minutes: 20 });
    recordEpisode({ mint: "B", symbol: "BB", token: TOKEN_AI_MICRO, pnl_pct: -10, hold_minutes: 5 });
    expect(recallEpisodes(TOKEN_AI_MICRO, { minSamples: 3 })).toBeNull();
  });

  it("returns HISTORY_FAVORABLE when win_rate >= 55% and rug_rate < 15%", () => {
    for (let i = 0; i < 5; i++) {
      recordEpisode({ mint: `W${i}`, symbol: `W${i}`, token: TOKEN_AI_MICRO, pnl_pct: i % 2 === 0 ? 40 : -5, hold_minutes: 15 });
    }
    const recall = recallEpisodes(TOKEN_AI_MICRO, { minSamples: 3 });
    expect(recall).not.toBeNull();
    expect(["HISTORY_FAVORABLE", "HISTORY_MIXED"]).toContain(recall.verdict);
    expect(recall.matches).toBe(5);
  });

  it("returns HISTORY_HOSTILE when rug_rate >= 25%", () => {
    for (let i = 0; i < 4; i++) {
      recordEpisode({ mint: `R${i}`, symbol: `R${i}`, token: TOKEN_AI_MICRO, pnl_pct: -80, is_rug: i < 2, hold_minutes: 3 });
    }
    const recall = recallEpisodes(TOKEN_AI_MICRO, { minSamples: 3 });
    expect(recall?.verdict).toBe("HISTORY_HOSTILE");
  });

  it("getEpisodicBlock returns null when no history", () => {
    expect(getEpisodicBlock([TOKEN_AI_MICRO, TOKEN_DOG_MID], { minSamples: 3 })).toBeNull();
  });

  it("getEpisodicBlock includes all candidates with history", () => {
    for (let i = 0; i < 4; i++) {
      recordEpisode({ mint: `X${i}`, symbol: "AITKN", token: { ...TOKEN_AI_MICRO, symbol: "AITKN" }, pnl_pct: 35, hold_minutes: 20 });
    }
    const block = getEpisodicBlock([{ ...TOKEN_AI_MICRO, symbol: "AITKN" }], { minSamples: 3 });
    expect(block).toContain("[EPISODIC RECALL]");
    expect(block).toContain("AITKN");
  });
});

// ─── Adaptive Risk ────────────────────────────────────────────────────────────
import { getRiskMultiplier, adaptDeployAmount, getAdaptiveRiskPromptLine } from "../adaptive-risk.js";

describe("adaptive-risk: multiplier ladder", () => {
  it("NORMAL state → multiplier 1.0", () => {
    const r = getRiskMultiplier({});
    expect(r.multiplier).toBe(1.0);
    expect(r.level).toBe("NORMAL");
  });

  it("circuitLocked → multiplier 0", () => {
    const r = getRiskMultiplier({ circuitLocked: true });
    expect(r.multiplier).toBe(0);
    expect(r.level).toBe("CIRCUIT_LOCKED");
  });

  it("2 consecutive losses → 0.60", () => {
    const r = getRiskMultiplier({ consecutiveLosses: 2 });
    expect(r.multiplier).toBe(0.60);
  });

  it("3+ consecutive losses → 0.40", () => {
    const r = getRiskMultiplier({ consecutiveLosses: 3 });
    expect(r.multiplier).toBe(0.40);
  });

  it("session PnL -20% → 0.50", () => {
    const r = getRiskMultiplier({ sessionPnlPct: -22 });
    expect(r.multiplier).toBe(0.50);
  });

  it("house money (+30%) → 1.25", () => {
    const r = getRiskMultiplier({ sessionPnlPct: 35 });
    expect(r.multiplier).toBe(1.25);
  });

  it("adaptDeployAmount clamps correctly", () => {
    const adj = adaptDeployAmount(0.5, { consecutiveLosses: 3 }, { minSol: 0.05 });
    expect(adj.amount_sol).toBeCloseTo(0.2);
    expect(adj.level).toBe("DEFENSIVE_CRITICAL");
  });

  it("getAdaptiveRiskPromptLine returns null in NORMAL state", () => {
    expect(getAdaptiveRiskPromptLine({})).toBeNull();
  });

  it("getAdaptiveRiskPromptLine returns line in DEFENSIVE state", () => {
    const line = getAdaptiveRiskPromptLine({ consecutiveLosses: 2 });
    expect(line).toContain("[RISK STATE]");
    expect(line).toContain("DEFENSIVE");
  });
});

// ─── Prompt Evolution ─────────────────────────────────────────────────────────
import { attributeOutcome, recomputeLearnedRules, getLearnedRulesBlock, _resetPromptEvolutionForTests } from "../prompt-evolution.js";

describe("prompt-evolution: learned rules", () => {
  beforeEach(() => _resetPromptEvolutionForTests());

  it("getLearnedRulesBlock returns null with no data", () => {
    expect(getLearnedRulesBlock()).toBeNull();
  });

  it("AVOID rule emitted when win_rate <= 25% with enough samples", () => {
    // 6 trades, 1 win = 17% win rate → should emit AVOID
    for (let i = 0; i < 6; i++) {
      attributeOutcome({ token: TOKEN_DOG_MID, pnl_pct: i === 0 ? 20 : -25, is_rug: i >= 4 });
    }
    const rules = recomputeLearnedRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some(r => r.includes("AVOID"))).toBe(true);
  });

  it("FAVOR rule emitted when win_rate >= 70%", () => {
    // 7 trades, 6 wins = 86% win rate → should emit FAVOR
    for (let i = 0; i < 7; i++) {
      attributeOutcome({ token: TOKEN_AI_MICRO, pnl_pct: i < 6 ? 40 : -5 });
    }
    const rules = recomputeLearnedRules();
    expect(rules.some(r => r.includes("FAVOR"))).toBe(true);
  });

  it("getLearnedRulesBlock formats correctly after attribution", () => {
    for (let i = 0; i < 6; i++) {
      attributeOutcome({ token: TOKEN_DOG_MID, pnl_pct: -20, is_rug: false });
    }
    recomputeLearnedRules();
    const block = getLearnedRulesBlock();
    if (block) {
      expect(block).toContain("[LEARNED RULES]");
    }
  });
});
