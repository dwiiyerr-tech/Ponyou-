import { describe, expect, it } from "vitest";
import { buildRiskPolicy, describeRiskPolicy, evaluateExitPolicy } from "../risk-policy.js";

describe("risk policy", () => {
  it("tightens cold markets and relaxes hot markets in bounded ways", () => {
    const hot = buildRiskPolicy({ marketCondition: "HOT" });
    const cold = buildRiskPolicy({ marketCondition: "COLD" });

    expect(hot.sizing.probeSizeFraction).toBeGreaterThan(cold.sizing.probeSizeFraction);
    expect(hot.entry.probeCautionThreshold).toBeGreaterThan(cold.entry.probeCautionThreshold);
    expect(hot.exit.trailingTriggerPct).toBeGreaterThan(cold.exit.trailingTriggerPct);
    expect(hot.exit.profitSweepPct).toBeGreaterThan(cold.exit.profitSweepPct);
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

  it("describes the policy without mutating it", () => {
    const policy = buildRiskPolicy({ marketCondition: "HOT" });
    const snapshot = describeRiskPolicy(policy);

    expect(snapshot.entry.hardBlockRugScore).toBe(policy.entry.hardBlockRugScore);
    expect(snapshot.exit.trailingTriggerPct).toBe(policy.exit.trailingTriggerPct);
    expect(snapshot.exit.trailingDropMode).toBe("absolute");
    expect(snapshot.rug.learnedReviewRequired).toBe(true);
  });
});
