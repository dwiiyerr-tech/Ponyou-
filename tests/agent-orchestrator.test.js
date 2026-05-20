import { afterEach, describe, expect, it } from "vitest";
import { _resetExperimentsForTests, createExperiment } from "../infra/agent-collab/experiment-tracker.js";
import { _resetSemanticMemoryForTests, addSemanticMemory } from "../infra/agent-collab/semantic-memory.js";
import {
  _resetOrchestrationForTests,
  addOrchestrationNote,
  advanceOrchestrationTask,
  createOrchestrationTask,
  getOpenHandoffs,
  getOrchestrationTask,
  listOrchestrationTasks,
} from "../infra/agent-collab/agent-orchestrator.js";

afterEach(() => {
  _resetOrchestrationForTests();
  _resetSemanticMemoryForTests();
  _resetExperimentsForTests();
});

describe("agent orchestrator", () => {
  it("creates a task with semantic context for the research stage", async () => {
    await addSemanticMemory({
      type: "postmortem",
      title: "AI holder blowoff",
      summary: "Watch coordinated holders in HOT AI names.",
      project: "ponyou",
      market_condition: "HOT",
      narrative: "AI",
      tier: "MICRO_CAP",
      tags: ["ai", "holder"],
    });

    const created = createOrchestrationTask({
      title: "Review token ABC",
      objective: "Research and decide whether ABC deserves a probe entry.",
      candidate: {
        symbol: "ABC",
        market_condition: "HOT",
        narrative: "AI",
        tier: "MICRO_CAP",
      },
      tags: ["ai", "probe"],
    });

    expect(created.task.current_stage).toBe("research");
    expect(created.context.semantic_matches.length).toBeGreaterThan(0);
  });

  it("advances tasks through stages and exposes handoffs by owner", () => {
    const experiment = createExperiment({
      name: "Probe filter",
      hypothesis: "Lower rug threshold improves probe quality",
      baseline_rule: "rug_score<35",
      candidate_rule: "rug_score<28",
    });

    const created = createOrchestrationTask({
      title: "Probe candidate XYZ",
      objective: "Evaluate XYZ under the new probe filter.",
      experiment_id: experiment.id,
    });

    const advanced = advanceOrchestrationTask({
      id: created.task.id,
      next_stage: "evaluate",
      note: "Research complete; pass to Codex for implementation review.",
      agent: "gemini",
      cli: "gemini",
    });

    expect(advanced.task.current_stage).toBe("evaluate");

    const handoffs = getOpenHandoffs({ owner: "codex", limit: 5 });
    expect(handoffs[0].id).toBe(created.task.id);
    expect(handoffs[0].owner).toBe("codex");
  });

  it("records stage notes and returns enriched task context", () => {
    const created = createOrchestrationTask({
      title: "Route execution review",
      objective: "Check if split route should be preferred.",
    });

    addOrchestrationNote({
      id: created.task.id,
      note: "Initial regime assessment says neutral.",
      agent: "claude",
      cli: "claude",
    });

    const fetched = getOrchestrationTask({ id: created.task.id });
    expect(fetched.task.stages[0].notes).toHaveLength(1);
    expect(fetched.task.history.length).toBeGreaterThan(1);
  });

  it("lists tasks by stage and status", () => {
    const first = createOrchestrationTask({
      title: "Task one",
      objective: "First objective",
    });
    advanceOrchestrationTask({
      id: first.task.id,
      next_stage: "evaluate",
      note: "handoff",
    });
    createOrchestrationTask({
      title: "Task two",
      objective: "Second objective",
    });

    const evaluateTasks = listOrchestrationTasks({ stage: "evaluate", limit: 5 });
    expect(evaluateTasks).toHaveLength(1);
    expect(evaluateTasks[0].title).toBe("Task one");
  });
});
