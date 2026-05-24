import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetRegimeMemoryForTests,
  buildTokenRegime,
  getRegimeAssessment,
  recordRegimeObservation,
  recordRegimeTradeOutcome,
} from "../regime-memory.js";

beforeEach(() => {
  _resetRegimeMemoryForTests();
});

describe("regime memory", () => {
  it("builds a stable regime key from token context", () => {
    const regime = buildTokenRegime({
      market_condition: "HOT",
      tier_execution: { tier: "MICRO_CAP" },
      conviction: { narrative_cluster: { narrative: "AI" } },
      workflow: { verdict: "probe" },
    });

    expect(regime.key).toBe("HOT|MICRO_CAP|AI|probe");
  });

  it("learns positive regimes and applies a tailwind multiplier", async () => {
    const token = {
      mint: "mintA",
      market_condition: "HOT",
      tier_execution: { tier: "MICRO_CAP" },
      conviction: { conviction_score: 72, narrative_cluster: { narrative: "AI" } },
      workflow: { verdict: "active" },
    };

    for (let i = 0; i < 3; i++) await recordRegimeObservation(token);
    await recordRegimeTradeOutcome({
      marketCondition: "HOT",
      tier: "MICRO_CAP",
      narrative: "AI",
      verdict: "active",
      pnl_pct: 55,
    });
    await recordRegimeTradeOutcome({
      marketCondition: "HOT",
      tier: "MICRO_CAP",
      narrative: "AI",
      verdict: "active",
      pnl_pct: 35,
    });

    const assessment = getRegimeAssessment(token);
    expect(assessment.regime_score).toBeGreaterThan(50);
    expect(assessment.stance).toBe("tailwind");
    expect(assessment.size_multiplier).toBeGreaterThan(1);
  });

  it("shrinks size when a regime keeps losing", async () => {
    const token = {
      mint: "mintB",
      market_condition: "COLD",
      tier_execution: { tier: "NEW_PAIR" },
      conviction: { conviction_score: 30, narrative_cluster: { narrative: "DOGS" } },
      workflow: { verdict: "probe" },
    };

    for (let i = 0; i < 2; i++) await recordRegimeObservation(token);
    await recordRegimeTradeOutcome({
      marketCondition: "COLD",
      tier: "NEW_PAIR",
      narrative: "DOGS",
      verdict: "probe",
      pnl_pct: -30,
    });
    await recordRegimeTradeOutcome({
      marketCondition: "COLD",
      tier: "NEW_PAIR",
      narrative: "DOGS",
      verdict: "probe",
      pnl_pct: -18,
    });

    const assessment = getRegimeAssessment(token);
    expect(assessment.regime_score).toBeLessThan(30);
    expect(assessment.stance).toBe("avoid");
    expect(assessment.size_multiplier).toBeLessThanOrEqual(0.4);
  });

  it("decays stale regime memory over time", async () => {
    const token = {
      mint: "mintC",
      market_condition: "HOT",
      tier_execution: { tier: "MID_CAP" },
      conviction: { conviction_score: 64, narrative_cluster: { narrative: "TECH" } },
      workflow: { verdict: "active" },
    };
    const start = Date.UTC(2026, 0, 1);
    await recordRegimeObservation(token, { nowMs: start });
    await recordRegimeTradeOutcome({
      marketCondition: "HOT",
      tier: "MID_CAP",
      narrative: "TECH",
      verdict: "active",
      pnl_pct: 40,
      nowMs: start,
    });

    const fresh = getRegimeAssessment(token, { nowMs: start });
    const stale = getRegimeAssessment(token, { nowMs: start + (9 * 24 * 60 * 60 * 1000) });
    expect(stale.regime_score).toBeLessThan(fresh.regime_score);
    expect(stale.decay_factor).toBeLessThan(1);
  });
});
