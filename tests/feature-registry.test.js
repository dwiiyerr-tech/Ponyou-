import { describe, it, expect, beforeEach } from "vitest";
import {
  registerFeature,
  unregisterFeature,
  enableFeature,
  disableFeature,
  isFeatureEnabled,
  listFeatures,
  runAllFeatures,
  getHealthReport,
  getHealthSummary,
  autoResetBreakers,
  registerDefaultFeatures,
} from "../feature-registry.js";

// Clean state before each test
beforeEach(() => {
  // Clear all registered features
  const features = listFeatures();
  for (const f of features) {
    unregisterFeature(f.name);
  }
});

describe("feature-registry — registerFeature", () => {
  it("registers a feature with weight and score function", () => {
    registerFeature({
      name: "test_signal",
      weight: 0.25,
      score: () => 75,
    });
    const list = listFeatures();
    expect(list.find(f => f.name === "test_signal")).toBeDefined();
  });

  it("re-registering updates weight but keeps same object", () => {
    registerFeature({
      name: "test_signal",
      weight: 0.10,
      score: () => 50,
    });
    registerFeature({
      name: "test_signal",
      weight: 0.30,
      score: () => 80,
    });
    const list = listFeatures();
    expect(list.filter(f => f.name === "test_signal")).toHaveLength(1);
    expect(list.find(f => f.name === "test_signal").weight).toBe(0.30);
  });
});

describe("feature-registry — enable/disable", () => {
  it("disabling a feature prevents it from running", () => {
    registerFeature({ name: "f1", weight: 1.0, score: () => 50 });
    disableFeature("f1");
    expect(isFeatureEnabled("f1")).toBe(false);
    const result = runAllFeatures({});
    expect(result.gates["f1"]).toBe("disabled");
    expect(result.aggregate).toBe(0);
  });

  it("re-enabling a disabled feature allows it to run", () => {
    registerFeature({ name: "f1", weight: 1.0, score: () => 50 });
    disableFeature("f1");
    enableFeature("f1");
    expect(isFeatureEnabled("f1")).toBe(true);
    const result = runAllFeatures({});
    expect(result.gates["f1"]).toBe(true);
  });
});

describe("feature-registry — unregisterFeature", () => {
  it("removes feature from list and health", () => {
    registerFeature({ name: "temp", weight: 0.1, score: () => 10 });
    unregisterFeature("temp");
    const list = listFeatures();
    expect(list.find(f => f.name === "temp")).toBeUndefined();
  });
});

describe("feature-registry — runAllFeatures", () => {
  it("computes weighted aggregate score", () => {
    registerFeature({ name: "f1", weight: 0.5, score: () => 100 });
    registerFeature({ name: "f2", weight: 0.5, score: () => 80 });
    const result = runAllFeatures({});
    expect(result.aggregate).toBe(90);
    expect(result.passed).toBe(true);
  });

  it("high-weight feature below 15 marks failed", () => {
    registerFeature({ name: "critical", weight: 0.25, score: () => 10 }); // < 15
    const result = runAllFeatures({});
    expect(result.passed).toBe(false);
  });

  it("gate returning false skips feature", () => {
    registerFeature({
      name: "gated",
      weight: 0.3,
      score: () => 100,
      gate: () => false,
    });
    const result = runAllFeatures({});
    expect(result.gates["gated"]).toBe(false);
  });

  it("aggregate is 0 when total weight is 0", () => {
    const result = runAllFeatures({});
    expect(result.aggregate).toBe(0);
  });
});

describe("feature-registry — circuit breaker", () => {
  it("trips after 3 consecutive errors", () => {
    let calls = 0;
    registerFeature({
      name: "flaky",
      weight: 0.5,
      score: () => {
        calls++;
        throw new Error("fail");
      },
    });
    for (let i = 0; i < 3; i++) {
      runAllFeatures({});
    }
    const report = getHealthReport();
    const f = report.find(r => r.feature === "flaky");
    expect(f.breaker_tripped).toBe(true);
    expect(f.errors).toBe(3);
  });

  it("success resets consecutive error counter", () => {
    let shouldFail = true;
    registerFeature({
      name: "recovery",
      weight: 0.5,
      score: () => {
        if (shouldFail) { shouldFail = false; throw new Error("fail"); }
        return 50;
      },
    });
    runAllFeatures({}); // fail
    runAllFeatures({}); // succeed (resets counter)
    // Now fail 2 more — should NOT trip (only 2 consecutive)
    shouldFail = true;
    runAllFeatures({});
    runAllFeatures({});
    const report = getHealthReport();
    const f = report.find(r => r.feature === "recovery");
    expect(f.breaker_tripped).toBe(false);
  });
});

describe("feature-registry — autoResetBreakers", () => {
  it("resets old breakers after maxAgeMs", () => {
    let calls = 0;
    registerFeature({
      name: "old_breaker",
      weight: 0.5,
      score: () => { calls++; throw new Error("fail"); },
    });
    for (let i = 0; i < 3; i++) runAllFeatures({});
    expect(getHealthReport().find(r => r.feature === "old_breaker").breaker_tripped).toBe(true);
    // autoResetBreakers checks if breaker is older than maxAgeMs.
    // With maxAgeMs: -1, age (which is >= 0) will always be > -1.
    autoResetBreakers({ maxAgeMs: -1 });
    expect(getHealthReport().find(r => r.feature === "old_breaker").breaker_tripped).toBe(false);
  });
});

describe("feature-registry — getHealthSummary", () => {
  it("reports healthy/tripped/disabled counts", () => {
    registerDefaultFeatures();
    const summary = getHealthSummary();
    expect(summary.total_features).toBeGreaterThan(0);
    expect(summary.healthy + summary.tripped + summary.disabled).toBe(summary.total_features);
  });
});

describe("feature-registry — registerDefaultFeatures", () => {
  it("registers all 8 default signals", () => {
    registerDefaultFeatures();
    const list = listFeatures();
    expect(list.length).toBe(8);
    const names = list.map(f => f.name);
    expect(names).toContain("conviction");
    expect(names).toContain("narrative_velocity");
    expect(names).toContain("cross_batch_velocity");
    expect(names).toContain("kelly_edge");
    expect(names).toContain("technicals");
    expect(names).toContain("rug_risk");
    expect(names).toContain("workflow_verdict");
    expect(names).toContain("cabal_risk");
  });

  it("default features run with mock context", () => {
    registerDefaultFeatures();
    const result = runAllFeatures({
      conviction: { conviction_score: 70, confidence_score: 60, stance: "neutral" },
      velocity: { velocities: { ai: { velocity_score: 50 } } },
      narrativeTags: ["ai"],
      crossBatch: { active: [] },
      kelly: { effective_fraction: 0.1 },
      technicals: { momentum_score: 40 },
      marketCondition: "HOT",
      regime: { stance: "strong" },
      token: { rug_score: 10 },
      workflow: { verdict: "active" },
      cabal: { cabalScore: 0, action: "WATCH_ONLY" },
    });
    expect(result.aggregate).toBeGreaterThanOrEqual(0);
    expect(result.aggregate).toBeLessThanOrEqual(100);
  });
});
