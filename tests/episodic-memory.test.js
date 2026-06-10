import { describe, it, expect, beforeEach } from "vitest";
import {
  fingerprint,
  recordEpisode,
  recallEpisodes,
  getEpisodicSummaryBlock,
  _resetEpisodicMemoryForTests,
} from "../episodic-memory.js";

beforeEach(() => _resetEpisodicMemoryForTests());

// ─── fingerprint ─────────────────────────────────────────────────────────────

describe("fingerprint", () => {
  it("produces deterministic key from token shape", () => {
    const token = { mcap: 50_000, liquidity: 10_000, rug_score: 10, chain: "sol", tier: "FULL", narrative_tags: ["meme"] };
    const fp = fingerprint(token);
    expect(fp).toBe(fingerprint(token));
    expect(typeof fp).toBe("string");
    expect(fp).toContain("sol");
    expect(fp).toContain("mcap:");
    expect(fp).toContain("liq:");
  });

  it("coarsens tokens into bands — same band = same key", () => {
    const a = { mcap: 35_000, liquidity: 6_000, rug_score: 5, chain: "sol", tier: "FULL" };
    const b = { mcap: 90_000, liquidity: 18_000, rug_score: 3, chain: "sol", tier: "FULL" };
    // Both fall in mcap:30-100k and liq:5-20k, same narrative fallback
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("different chain → different key", () => {
    const a = { mcap: 50_000, liquidity: 10_000, chain: "sol" };
    const b = { mcap: 50_000, liquidity: 10_000, chain: "base" };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("handles missing fields gracefully", () => {
    expect(() => fingerprint({})).not.toThrow();
    expect(typeof fingerprint({})).toBe("string");
  });
});

// ─── recordEpisode + recallEpisodes ──────────────────────────────────────────

describe("recordEpisode / recallEpisodes", () => {
  const token = { mcap: 50_000, liquidity: 10_000, rug_score: 5, chain: "sol", tier: "FULL" };

  it("returns null when no history exists", async () => {
    const result = await recallEpisodes(token);
    expect(result).toBeNull();
  });

  it("returns null when below minSamples", async () => {
    await recordEpisode({ mint: "aaa", symbol: "TST", token, pnl_pct: 20 });
    await recordEpisode({ mint: "bbb", symbol: "TST", token, pnl_pct: -10 });
    const result = await recallEpisodes(token, { minSamples: 3 });
    expect(result).toBeNull();
  });

  it("returns stats after enough samples", async () => {
    for (let i = 0; i < 4; i++) {
      await recordEpisode({ mint: `m${i}`, symbol: "TST", token, pnl_pct: i % 2 === 0 ? 20 : -5 });
    }
    const result = await recallEpisodes(token, { minSamples: 3 });
    expect(result).not.toBeNull();
    expect(result.matches).toBe(4);
    expect(result.win_rate).toBeCloseTo(0.5, 1);
  });

  it("verdict HISTORY_FAVORABLE when wr >= 55% and rug < 15%", async () => {
    for (let i = 0; i < 5; i++) {
      await recordEpisode({ mint: `m${i}`, symbol: "TST", token, pnl_pct: 25 });
    }
    const result = await recallEpisodes(token, { minSamples: 3 });
    expect(result.verdict).toBe("HISTORY_FAVORABLE");
  });

  it("verdict HISTORY_HOSTILE when rug rate >= 25%", async () => {
    for (let i = 0; i < 4; i++) {
      await recordEpisode({ mint: `m${i}`, symbol: "TST", token, pnl_pct: i === 0 ? 10 : -30, is_rug: i >= 1 });
    }
    const result = await recallEpisodes(token, { minSamples: 3 });
    expect(result.verdict).toBe("HISTORY_HOSTILE");
  });
});

// ─── getEpisodicSummaryBlock ──────────────────────────────────────────────────

describe("getEpisodicSummaryBlock", () => {
  it("returns null on empty store", () => {
    expect(getEpisodicSummaryBlock()).toBeNull();
  });

  it("returns null when all patterns below minSamples", async () => {
    const token = { mcap: 50_000, liquidity: 10_000, chain: "sol", tier: "FULL" };
    await recordEpisode({ mint: "a", symbol: "X", token, pnl_pct: 20 });
    await recordEpisode({ mint: "b", symbol: "X", token, pnl_pct: 10 });
    // only 2 samples, minSamples=3
    expect(getEpisodicSummaryBlock({ minSamples: 3 })).toBeNull();
  });

  it("includes FAVORABLE pattern when wr >= 55% and rug < 15%", async () => {
    const token = { mcap: 50_000, liquidity: 10_000, rug_score: 5, chain: "sol", tier: "FULL" };
    for (let i = 0; i < 5; i++) {
      await recordEpisode({ mint: `m${i}`, symbol: "TST", token, pnl_pct: 30 });
    }
    const block = getEpisodicSummaryBlock({ minSamples: 3 });
    expect(block).not.toBeNull();
    expect(block).toContain("FAVORABLE");
    expect(block).toContain("EPISODIC PATTERNS");
  });

  it("includes HOSTILE pattern when rug rate >= 25%", async () => {
    const token = { mcap: 200_000, liquidity: 1_000, rug_score: 40, chain: "sol", tier: "UNKNOWN" };
    for (let i = 0; i < 4; i++) {
      await recordEpisode({ mint: `r${i}`, symbol: "RUG", token, pnl_pct: -50, is_rug: i < 2 });
    }
    const block = getEpisodicSummaryBlock({ minSamples: 3 });
    expect(block).not.toBeNull();
    expect(block).toContain("HOSTILE");
  });

  it("returns null when patterns exist but none qualify as FAVORABLE or HOSTILE", async () => {
    // win rate ~50%, rug rate 0% → MIXED, excluded from summary
    const token = { mcap: 50_000, liquidity: 10_000, rug_score: 5, chain: "sol", tier: "FULL" };
    for (let i = 0; i < 4; i++) {
      await recordEpisode({ mint: `m${i}`, symbol: "TST", token, pnl_pct: i % 2 === 0 ? 15 : -10 });
    }
    // MIXED patterns are not included
    const block = getEpisodicSummaryBlock({ minSamples: 3 });
    expect(block).toBeNull();
  });

  it("limits output to topN entries per category", async () => {
    // Use distinct tiers to guarantee distinct fingerprints (tier is part of the key)
    const tiers = ["FULL", "STANDA", "BASIC", "LITE", "UNKNOW"];
    for (let k = 0; k < 5; k++) {
      const tok = { mcap: 50_000, liquidity: 10_000, rug_score: 3, chain: "sol", tier: tiers[k] };
      for (let i = 0; i < 4; i++) {
        await recordEpisode({ mint: `f${k}${i}`, symbol: `TK${k}`, token: tok, pnl_pct: 30 });
      }
    }
    const block = getEpisodicSummaryBlock({ minSamples: 3, topN: 2 });
    // Filter only pattern lines (start with "  FAVORABLE:"), not the footer hint
    const favorableLines = (block || "").split("\n").filter(l => l.trimStart().startsWith("FAVORABLE:"));
    expect(favorableLines.length).toBe(2);
  });

  it("block contains fingerprint components readable as strategy hints", async () => {
    const token = { mcap: 50_000, liquidity: 10_000, rug_score: 5, chain: "sol", tier: "FULL", narrative_tags: ["meme"] };
    for (let i = 0; i < 4; i++) {
      await recordEpisode({ mint: `m${i}`, symbol: "TST", token, pnl_pct: 25 });
    }
    const block = getEpisodicSummaryBlock({ minSamples: 3 });
    expect(block).toContain("mcap:");
    expect(block).toContain("liq:");
    expect(block).toContain("sol");
  });

  it("footer hint is present in the block", async () => {
    const token = { mcap: 50_000, liquidity: 10_000, rug_score: 3, chain: "sol", tier: "FULL" };
    for (let i = 0; i < 5; i++) {
      await recordEpisode({ mint: `m${i}`, symbol: "T", token, pnl_pct: 30 });
    }
    const block = getEpisodicSummaryBlock({ minSamples: 3 });
    expect(block).toContain("Target FAVORABLE");
  });
});
