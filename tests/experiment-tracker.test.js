import { afterEach, describe, expect, it } from "vitest";
import {
  _resetExperimentsForTests,
  createExperiment,
  getExperimentOverview,
  getExperimentSummary,
  listExperiments,
  recordExperimentRun,
  updateExperimentStatus,
} from "../infra/agent-collab/experiment-tracker.js";

afterEach(() => {
  _resetExperimentsForTests();
});

describe("experiment tracker", () => {
  it("creates experiments with a minimum sample size", () => {
    const experiment = createExperiment({
      name: "Probe size uplift",
      hypothesis: "A larger probe wins faster in HOT regimes",
      baseline_rule: "probeSizeFraction=0.35",
      candidate_rule: "probeSizeFraction=0.45",
      owner: "codex",
      minimum_sample_size: 40,
      tags: ["risk", "sizing"],
    });

    expect(experiment.id).toBe(1);
    expect(experiment.minimum_sample_size).toBe(40);
    expect(listExperiments({ limit: 5 })).toHaveLength(1);
  });

  it("records baseline and candidate runs and computes a promotion recommendation", () => {
    const experiment = createExperiment({
      name: "Holder risk filter tuning",
      hypothesis: "Tighter holder risk threshold improves quality score",
      baseline_rule: "maxTop10Pct=55",
      candidate_rule: "maxTop10Pct=45",
      owner: "claude",
      minimum_sample_size: 30,
    });

    recordExperimentRun({
      experiment_id: experiment.id,
      variant: "baseline",
      sample_size: 18,
      wins: 9,
      losses: 9,
      pnl_pct: 8,
      max_drawdown_pct: 15,
      avg_slippage: 0.05,
      false_positive_rate: 0.28,
    });

    const recorded = recordExperimentRun({
      experiment_id: experiment.id,
      variant: "candidate",
      sample_size: 18,
      wins: 12,
      losses: 6,
      pnl_pct: 21,
      max_drawdown_pct: 13,
      avg_slippage: 0.03,
      false_positive_rate: 0.16,
      rugs_avoided: 3,
    });

    expect(recorded.summary.summary.sample_size).toBe(36);
    expect(recorded.summary.summary.recommendation).toBe("promote_candidate");
    expect(recorded.summary.summary.comparison.quality_lift).toBeGreaterThan(0);
  });

  it("keeps insufficient-data status until the threshold is met", () => {
    const experiment = createExperiment({
      name: "Narrative tail capture",
      hypothesis: "Delayed exit captures more tail upside",
      baseline_rule: "takeProfitPct=35",
      candidate_rule: "takeProfitPct=45",
      minimum_sample_size: 50,
    });

    recordExperimentRun({
      experiment_id: experiment.id,
      variant: "candidate",
      sample_size: 12,
      wins: 7,
      losses: 5,
      pnl_pct: 10,
      max_drawdown_pct: 8,
    });

    const summary = getExperimentSummary({ id: experiment.id });
    expect(summary.summary.recommendation).toBe("insufficient_data");
  });

  it("updates experiment status and surfaces overview rows", () => {
    const experiment = createExperiment({
      name: "Execution route selection",
      hypothesis: "Prefer split routes in HOT markets",
      baseline_rule: "split=false",
      candidate_rule: "split=true",
      owner: "gemini",
    });

    const updated = updateExperimentStatus({
      id: experiment.id,
      status: "running",
      notes: "Activated for the next live cohort.",
    });

    expect(updated.status).toBe("running");

    const overview = getExperimentOverview({ limit: 5 });
    expect(overview[0].name).toBe("Execution route selection");
    expect(overview[0].status).toBe("running");
  });
});
