import { afterEach, describe, expect, it } from "vitest";
import {
  _resetExperimentsForTests,
  createExperiment,
  recordExperimentRun,
} from "../infra/agent-collab/experiment-tracker.js";
import {
  _resetSemanticMemoryForTests,
  addSemanticMemory,
  getRecentSemanticMemory,
  indexExperimentMemory,
  searchSemanticMemory,
} from "../infra/agent-collab/semantic-memory.js";

afterEach(() => {
  _resetSemanticMemoryForTests();
  _resetExperimentsForTests();
});

describe("semantic memory", () => {
  it("stores and retrieves semantic notes with filter boosts", async () => {
    await addSemanticMemory({
      type: "postmortem",
      title: "Holder trap in HOT AI regime",
      summary: "Avoid clustered holders when AI narrative is overheating.",
      details: "Token failed despite momentum because top wallets were coordinated.",
      tags: ["holder", "risk", "ai"],
      project: "ponyou",
      market_condition: "HOT",
      narrative: "AI",
      tier: "MICRO_CAP",
    });

    const results = searchSemanticMemory({
      query: "holder ai hot",
      project: "ponyou",
      market_condition: "HOT",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("postmortem");
    expect(results[0].score).toBeGreaterThan(20);
  });

  it("indexes experiment summaries into semantic memory", async () => {
    const experiment = createExperiment({
      name: "Kelly floor adjustment",
      hypothesis: "Raise Kelly floor in HOT trend continuation",
      baseline_rule: "riskPerTrade=0.02",
      candidate_rule: "riskPerTrade=0.025",
      minimum_sample_size: 20,
      tags: ["kelly", "risk"],
    });

    recordExperimentRun({
      experiment_id: experiment.id,
      variant: "baseline",
      sample_size: 10,
      wins: 5,
      losses: 5,
      pnl_pct: 8,
      max_drawdown_pct: 10,
    });

    recordExperimentRun({
      experiment_id: experiment.id,
      variant: "candidate",
      sample_size: 12,
      wins: 8,
      losses: 4,
      pnl_pct: 18,
      max_drawdown_pct: 9,
    });

    const indexed = await indexExperimentMemory({ experiment_id: experiment.id });
    expect(indexed.type).toBe("experiment");

    const results = searchSemanticMemory({ query: "kelly risk experiment", tag: "experiment" });
    expect(results[0].title).toContain("Kelly floor adjustment");
  });

  it("returns recent entries in descending time order", async () => {
    await addSemanticMemory({
      type: "risk-note",
      title: "First note",
      summary: "Initial observation.",
    });
    await addSemanticMemory({
      type: "risk-note",
      title: "Second note",
      summary: "Later observation.",
    });

    const recent = getRecentSemanticMemory({ limit: 2, type: "risk-note" });
    expect(recent[0].title).toBe("Second note");
    expect(recent[1].title).toBe("First note");
  });
});
