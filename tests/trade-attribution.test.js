import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetTradeAttributionForTests,
  assessTradeAttribution,
  getAttributionSummary,
  recordTradeAttribution,
} from "../trade-attribution.js";

beforeEach(() => {
  _resetTradeAttributionForTests();
});

describe("trade attribution", () => {
  it("attributes weak, risky entries to pick quality", () => {
    const attribution = assessTradeAttribution({
      tracked: {
        signal_snapshot: {
          rug_score: 38,
          conviction: { conviction_score: 28 },
          regime: { regime_score: 32, confidence_score: 45 },
          workflow: { caution_score: 36, verdict: "probe" },
          kelly: { should_skip: false },
          execution_context: { slippage: 0.5 },
        },
      },
      exit: {
        pnl_pct: -35,
        hold_minutes: 25,
        exit_reason: "Stop Loss",
      },
      executionQuality: { quality_score: 70, avg_slippage: 0.5, avg_latency_ms: 1200 },
    });

    expect(attribution.primary_cause).toBe("pick");
    expect(attribution.scores.pick).toBeGreaterThan(attribution.scores.execution);
  });

  it("attributes strong setups failing fast to timing", () => {
    const attribution = assessTradeAttribution({
      tracked: {
        signal_snapshot: {
          rug_score: 8,
          conviction: { conviction_score: 74 },
          regime: { regime_score: 68, confidence_score: 55 },
          workflow: { caution_score: 8, verdict: "active" },
          kelly: { should_skip: false },
          execution_context: { slippage: 0.4 },
        },
      },
      exit: {
        pnl_pct: -12,
        hold_minutes: 4,
        exit_reason: "Stop Loss",
      },
      executionQuality: { quality_score: 72, avg_slippage: 0.4, avg_latency_ms: 800 },
    });

    expect(attribution.primary_cause).toBe("timing");
    expect(attribution.scores.timing).toBeGreaterThan(attribution.scores.pick);
  });

  it("attributes poor fill conditions to execution", () => {
    const attribution = assessTradeAttribution({
      tracked: {
        signal_snapshot: {
          rug_score: 6,
          conviction: { conviction_score: 71 },
          regime: { regime_score: 64, confidence_score: 50 },
          workflow: { caution_score: 10, verdict: "active" },
          kelly: { should_skip: false },
          execution_context: { slippage: 2.2 },
        },
      },
      exit: {
        pnl_pct: -8,
        hold_minutes: 2,
        exit_reason: "Stop Loss",
      },
      executionQuality: { quality_score: 24, avg_slippage: 2.2, avg_latency_ms: 5200 },
    });

    expect(attribution.primary_cause).toBe("execution");
    expect(attribution.scores.execution).toBeGreaterThan(attribution.scores.timing);
  });

  it("stores attribution counts in summary", async () => {
    await recordTradeAttribution({ primary_cause: "pick" });
    await recordTradeAttribution({ primary_cause: "timing" });
    await recordTradeAttribution({ primary_cause: "execution" });
    await recordTradeAttribution({ primary_cause: "mixed" });

    const summary = getAttributionSummary();
    expect(summary.total).toBe(4);
    expect(summary.pick).toBe(1);
    expect(summary.timing).toBe(1);
    expect(summary.execution).toBe(1);
    expect(summary.mixed).toBe(1);
  });
});
