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

  it("describes the policy without mutating it", () => {
    const policy = buildRiskPolicy({ marketCondition: "HOT" });
    const snapshot = describeRiskPolicy(policy);

    expect(snapshot.entry.hardBlockRugScore).toBe(policy.entry.hardBlockRugScore);
    expect(snapshot.exit.trailingTriggerPct).toBe(policy.exit.trailingTriggerPct);
    expect(snapshot.rug.learnedReviewRequired).toBe(true);
  });
});
