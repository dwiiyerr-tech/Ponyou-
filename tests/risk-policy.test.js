import { describe, expect, it } from "vitest";
import { buildRiskPolicy, describeRiskPolicy, evaluateExitPolicy } from "../risk-policy.js";

describe("risk policy", () => {
  it("tightens cold markets and relaxes hot markets in bounded ways", () => {
    const hot = buildRiskPolicy({ marketCondition: "HOT" });
    const cold = buildRiskPolicy({ marketCondition: "COLD" });

    // HOT lets you take larger probe sizes than COLD (momentum vs freeze)
    expect(hot.sizing.probeSizeFraction).toBeGreaterThan(cold.sizing.probeSizeFraction);
    // HOT tightens exit stops more than COLD (faster dumps)
    expect(Math.abs(hot.exit.hardStopLossPct)).toBeGreaterThan(Math.abs(cold.exit.hardStopLossPct));
    expect(hot.exit.trailingTriggerPct).toBeGreaterThan(cold.exit.trailingTriggerPct);
    expect(hot.exit.profitSweepPct).toBeGreaterThan(cold.exit.profitSweepPct);
    // COLD requires higher conviction than HOT (volume is thin in colder markets)
    expect(cold.entry.probeConfidenceFloor).toBeGreaterThan(hot.entry.probeConfidenceFloor);
  });

  it("disables probe sizing in dead markets", () => {
    const dead = buildRiskPolicy({ marketCondition: "DEAD" });

    expect(dead.sizing.probeSizeFraction).toBe(0);
    expect(dead.entry.activeConfidenceFloor).toBe(100);
    expect(dead.exit.trailingTriggerPct).toBe(0);
    expect(dead.exit.profitSweepPct).toBe(0);
  });

  it("honors config overrides for stop loss and take profit", () => {
    const policy = buildRiskPolicy({
      config: {
        management: {
          stopLossPct: -12,
          takeProfitPct: 18,
        },
      },
    });

    expect(policy.exit.hardStopLossPct).toBe(-12);
    expect(policy.exit.immediateTakeProfitPct).toBe(18);
  });

  it("caps cold market stop loss and take profit overrides", () => {
    const policy = buildRiskPolicy({
      marketCondition: "COLD",
      config: {
        management: {
          stopLossPct: -20,
          takeProfitPct: 180,
        },
      },
    });

    expect(policy.exit.hardStopLossPct).toBe(-10);
    expect(policy.exit.immediateTakeProfitPct).toBe(130);
  });

  it("falls back to default stop loss when override is outside the valid range", () => {
    const policy = buildRiskPolicy({
      marketCondition: "COLD",
      config: {
        management: {
          stopLossPct: 0,
        },
      },
    });

    expect(policy.exit.hardStopLossPct).toBe(-10);
  });

  it("evaluates exit thresholds deterministically", () => {
    const policy = buildRiskPolicy({
      config: {
        management: {
          stopLossPct: -10,
          takeProfitPct: 20,
        },
      },
    });

    expect(evaluateExitPolicy({ pnlPct: -30, peakPnlPct: 0, policy }).hardCutLoss).toBe(true);
    expect(evaluateExitPolicy({ pnlPct: -11, peakPnlPct: 0, policy }).hardStopLoss).toBe(true);
    expect(evaluateExitPolicy({ pnlPct: 20, peakPnlPct: 22, policy }).takeProfit).toBe(true);
    expect(evaluateExitPolicy({ pnlPct: 1, peakPnlPct: 10, policy }).trailingStop).toBe(true);
    expect(evaluateExitPolicy({ pnlPct: 40, peakPnlPct: 40, policy }).profitSweepEligible).toBe(true);
  });

  it("supports proportional trailing stop drop from peak profit", () => {
    const policy = buildRiskPolicy();
    policy.exit.trailingDropMode = "proportional";
    policy.exit.trailingTriggerPct = 5;
    policy.exit.trailingDropPct = 6;

    expect(evaluateExitPolicy({ pnlPct: 9.5, peakPnlPct: 10, policy }).trailingStop).toBe(false);
    expect(evaluateExitPolicy({ pnlPct: 9.4, peakPnlPct: 10, policy }).trailingStop).toBe(true);
  });

  // M1 regression: DEAD-market -3% stop must not be overridden by a wider config stop.
  it("DEAD market clamps stop loss — config wide stop does not override (M1)", () => {
    const policy = buildRiskPolicy({
      marketCondition: "DEAD",
      config: { management: { stopLossPct: -20 } },
    });
    // -20 config must be clamped to -5 in DEAD (hardStopLossPct between -5 and 0)
    expect(policy.exit.hardStopLossPct).toBeGreaterThanOrEqual(-5);
    // hardCutLossPct must be more negative (deeper) than hardStopLossPct
    expect(policy.exit.hardCutLossPct).toBeLessThanOrEqual(policy.exit.hardStopLossPct);
  });

  // M2 regression: hardCutLossPct must always sit below hardStopLossPct after config override.
  it("hardCutLossPct is recomputed after config stop override — never shallower than stop (M2)", () => {
    const policy = buildRiskPolicy({
      config: { management: { stopLossPct: -25 } },
    });
    // cut must be deeper (more negative) than stop
    expect(policy.exit.hardCutLossPct).toBeLessThanOrEqual(policy.exit.hardStopLossPct);
  });

  it("describes the policy without mutating it", () => {
    const policy = buildRiskPolicy({ marketCondition: "HOT" });
    const snapshot = describeRiskPolicy(policy);

    expect(snapshot.entry.hardBlockRugScore).toBe(policy.entry.hardBlockRugScore);
    expect(snapshot.exit.trailingTriggerPct).toBe(policy.exit.trailingTriggerPct);
    expect(snapshot.exit.trailingDropMode).toBe("absolute");
    expect(snapshot.rug.learnedReviewRequired).toBe(true);
  });
});
