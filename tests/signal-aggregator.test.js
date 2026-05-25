import { describe, it, expect } from "vitest";
import { aggregateSignal } from "../signal-aggregator.js";

describe("signal-aggregator — aggregateSignal", () => {
  it("returns a number score with full input", () => {
    const result = aggregateSignal({
      conviction: { conviction_score: 60, confidence_score: 50, trending_boost: 10, sustained_boost: 5 },
      velocity: { velocities: { ai: { velocity_score: 70 } } },
      crossBatch: { active: [{ narrative: "ai", cross_batch_score: 55, is_sustained: true }] },
      regime: { stance: "strong" },
      kelly: { effective_fraction: 0.15, should_skip: false },
      technicals: { momentum_score: 30 },
      marketCondition: "HOT",
      narrativeTags: ["ai"],
    });
    expect(result.signal_score).toBeGreaterThanOrEqual(0);
    expect(result.signal_score).toBeLessThanOrEqual(100);
    expect(result.components).toBeDefined();
    expect(result.components.conviction).toBeGreaterThan(0);
    expect(result.components.velocity).toBeGreaterThan(0);
    expect(result.summary).toBeTruthy();
  });

  it("returns low score with empty input (technicals defaults to ~25-38)", () => {
    const result = aggregateSignal({});
    // With empty inputs: conviction=0, velocity=0, cross_batch=0,
    // narrative_boost=0, kelly=50 (default), technicals≈25 (default),
    // so score won't be 0 but it will be under 50
    expect(result.signal_score).toBeGreaterThanOrEqual(0);
    expect(result.signal_score).toBeLessThan(50);
  });

  it("kelly should_skip forces 0 kelly component", () => {
    const result = aggregateSignal({
      kelly: { should_skip: true },
    });
    expect(result.components.kelly).toBe(0);
  });

  it("COLD market condition reduces technicals component", () => {
    const hot = aggregateSignal({
      technicals: { momentum_score: 50 },
      marketCondition: "HOT",
    });
    const dead = aggregateSignal({
      technicals: { momentum_score: 50 },
      marketCondition: "DEAD",
    });
    // DEAD should have lower overall score than HOT with same inputs
    expect(dead.signal_score).toBeLessThan(hot.signal_score);
  });

  it("sustained cross-batch gets +15 bonus", () => {
    const withoutSustain = aggregateSignal({
      crossBatch: { active: [{ narrative: "defi", cross_batch_score: 50, is_sustained: false }] },
      narrativeTags: ["defi"],
    });
    const withSustain = aggregateSignal({
      crossBatch: { active: [{ narrative: "defi", cross_batch_score: 50, is_sustained: true }] },
      narrativeTags: ["defi"],
    });
    expect(withSustain.components.cross_batch).toBeGreaterThan(withoutSustain.components.cross_batch);
  });

  it("scores are clamped 0-100 for all components", () => {
    const result = aggregateSignal({
      conviction: { conviction_score: 200, confidence_score: 200 },
      velocity: { velocities: { x: { velocity_score: 200 } } },
      narrativeTags: ["x"],
    });
    expect(result.components.conviction).toBeLessThanOrEqual(100);
    expect(result.components.velocity).toBeLessThanOrEqual(100);
  });

  it("narrative_boost scales trending/sustained correctly", () => {
    const result = aggregateSignal({
      conviction: { trending_boost: 20, sustained_boost: 10 },
    });
    // trending_boost * 2.5 + sustained_boost * 4 = 50 + 40 = 90
    expect(result.components.narrative_boost).toBeGreaterThanOrEqual(80);
  });

  it("velocity handles tagged string narrative tags", () => {
    const result = aggregateSignal({
      velocity: { velocities: { meme: { velocity_score: 85 } } },
      narrativeTags: ["meme"],
    });
    expect(result.components.velocity).toBeGreaterThan(0);
  });

  it("velocity handles object narrative tags", () => {
    const result = aggregateSignal({
      velocity: { velocities: { gaming: { velocity_score: 72 } } },
      narrativeTags: [{ narrative: "gaming" }],
    });
    expect(result.components.velocity).toBeGreaterThan(0);
  });
});
