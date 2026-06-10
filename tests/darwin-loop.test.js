/**
 * Tests for the darwinian learning loop:
 *   - triggeredSignals extracts the components that voted for a token
 *   - aggregateSignal honors darwinWeights (re-weighted + renormalized)
 *   - updateDarwinWeights auto-registers unseen signal names
 *   - shadow-watchlist classifies expired peaked tokens as "mooned", emits
 *     shadow:winner_missed, and feeds darwin in both directions
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

import { aggregateSignal, triggeredSignals } from "../signal-aggregator.js";

// ─── triggeredSignals ────────────────────────────────────────────────────────

describe("triggeredSignals", () => {
  it("returns components at/above the threshold", () => {
    const signal = { components: { conviction: 80, velocity: 60, kelly: 50, social_buzz: 0 } };
    expect(triggeredSignals(signal)).toEqual(["conviction", "velocity"]);
  });

  it("is safe on missing/empty input", () => {
    expect(triggeredSignals(null)).toEqual([]);
    expect(triggeredSignals({})).toEqual([]);
  });

  it("respects a custom threshold", () => {
    const signal = { components: { conviction: 45 } };
    expect(triggeredSignals(signal, { threshold: 40 })).toEqual(["conviction"]);
  });
});

// ─── aggregateSignal darwin re-weighting ─────────────────────────────────────

describe("aggregateSignal darwinWeights", () => {
  const baseInput = { conviction: { conviction_score: 100, confidence_score: 100 } };

  it("returns renormalized weights summing to ~1", () => {
    const out = aggregateSignal({
      ...baseInput,
      darwinWeights: { conviction: { weight: 2.0 }, velocity: { weight: 0.5 } },
    });
    const sum = Object.values(out.weights).reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 6);
    // conviction got boosted relative to its base 0.28
    expect(out.weights.conviction).toBeGreaterThan(0.28);
  });

  it("boosting a strong component raises the score; decaying it lowers", () => {
    const neutral = aggregateSignal(baseInput);
    const boosted = aggregateSignal({ ...baseInput, darwinWeights: { conviction: { weight: 2.5 } } });
    const decayed = aggregateSignal({ ...baseInput, darwinWeights: { conviction: { weight: 0.3 } } });
    expect(boosted.signal_score).toBeGreaterThan(neutral.signal_score);
    expect(decayed.signal_score).toBeLessThan(neutral.signal_score);
  });

  it("no darwin data → identical to base weighting", () => {
    const a = aggregateSignal(baseInput);
    const b = aggregateSignal({ ...baseInput, darwinWeights: null });
    expect(a.signal_score).toBe(b.signal_score);
    expect(b.weights.conviction).toBeCloseTo(0.28, 6);
  });

  it("ignores invalid weights (zero/negative/NaN)", () => {
    const out = aggregateSignal({
      ...baseInput,
      darwinWeights: { conviction: { weight: 0 }, velocity: { weight: -2 }, kelly: { weight: "x" } },
    });
    const base = aggregateSignal(baseInput);
    expect(out.signal_score).toBe(base.signal_score);
  });
});

// ─── updateDarwinWeights auto-registration ───────────────────────────────────

describe("updateDarwinWeights auto-registration", () => {
  it("registers unseen signal names and applies the outcome", async () => {
    const darwinFile = process.env.PONYOU_DARWIN_FILE;
    expect(darwinFile).toBeTruthy(); // vitest env redirect must be active
    try { fs.unlinkSync(darwinFile); } catch { /* fresh start */ }

    const { updateDarwinWeights, getDarwinWeights } = await import("../lessons.js");
    updateDarwinWeights(["conviction", "velocity"], 42, {});
    const weights = getDarwinWeights();
    // Previously unknown names were dropped; now they enter at 1.0 and get
    // the win boost immediately.
    expect(weights.conviction).toBeTruthy();
    expect(weights.conviction.weight).toBeCloseTo(1.05, 3);
    expect(weights.conviction.success_count).toBe(1);
    expect(weights.velocity.success_count).toBe(1);

    updateDarwinWeights(["conviction"], -100, {});
    const after = getDarwinWeights();
    expect(after.conviction.failure_count).toBe(1);
    expect(after.conviction.weight).toBeLessThan(1.05);
  });
});
