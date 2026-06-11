import fs from "fs";
import { afterEach, describe, expect, it } from "vitest";
import { _resetExperimentsForTests, createExperiment, recordExperimentRun } from "../infra/agent-collab/experiment-tracker.js";
import { _resetOrchestrationForTests, addOrchestrationNote, createOrchestrationTask, getOrchestrationTask } from "../infra/agent-collab/agent-orchestrator.js";
import { _resetSemanticMemoryForTests } from "../infra/agent-collab/semantic-memory.js";
import { _resetWorkflowArtifactsForTests, workflowBuild, workflowPlan, workflowSpec, workflowTesting } from "../infra/agent-collab/workflow-bridge.js";
import { finalizeTaskWithPolicy, validateTaskPolicy } from "../infra/agent-collab/policy-gate.js";

afterEach(() => {
  _resetExperimentsForTests();
  _resetOrchestrationForTests();
  _resetSemanticMemoryForTests();
  _resetWorkflowArtifactsForTests();
});

describe("policy gate", () => {
  it("rejects finalization when required artifacts are missing", () => {
    const task = createOrchestrationTask({
      title: "Incomplete task",
      objective: "This task is missing required artifacts.",
    });

    const validation = validateTaskPolicy({ task_id: task.task.id });
    expect(validation.passes).toBe(false);
    expect(validation.issues).toContain("Missing spec artifact.");

    const finalized = finalizeTaskWithPolicy({
      task_id: task.task.id,
      agent: "claude",
    });
    expect(finalized.error).toBe("Policy gate failed.");
  });

  it("allows Claude to finalize when policy requirements are met", { timeout: 15000 }, async () => {
    const experiment = createExperiment({
      name: "Healthy experiment",
      hypothesis: "Route awareness improves quality",
      baseline_rule: "route=default",
      candidate_rule: "route=aware",
      minimum_sample_size: 10,
    });

    recordExperimentRun({
      experiment_id: experiment.id,
      variant: "baseline",
      sample_size: 10,
      wins: 5,
      losses: 5,
      pnl_pct: 5,
      max_drawdown_pct: 8,
    });
    recordExperimentRun({
      experiment_id: experiment.id,
      variant: "candidate",
      sample_size: 10,
      wins: 7,
      losses: 3,
      pnl_pct: 15,
      max_drawdown_pct: 7,
    });

    const task = createOrchestrationTask({
      title: "Complete task",
      objective: "This task should satisfy the policy gate.",
      experiment_id: experiment.id,
    });

    await workflowSpec({
      task_id: task.task.id,
      problem_statement: "Need safer route selection.",
      success_criteria: ["Improve quality"],
    });
    await workflowPlan({
      task_id: task.task.id,
      milestones: ["Define route rules", "Validate route performance"],
    });
    await workflowBuild({
      task_id: task.task.id,
      changes: ["Implemented route-aware logic"],
      files: ["executor.js"],
      verification: ["Build verified"],
    });
    await workflowTesting({
      task_id: task.task.id,
      test_plan: ["Run route tests"],
      test_results: ["Route tests passed"],
    });

    const finalized = finalizeTaskWithPolicy({
      task_id: task.task.id,
      agent: "claude",
      cli: "claude",
      note: "Claude approves completion after successful testing.",
    });

    expect(finalized.ok).toBe(true);
    const refreshed = getOrchestrationTask({ id: task.task.id });
    expect(refreshed.task.status).toBe("completed");
  });
});

describe("stage-skip enforcement", () => {
  it("blocks finalize on a silently skipped stage, allows it with a waiver note", { timeout: 15000 }, async () => {
    const task = createOrchestrationTask({ title: "Skip case", objective: "o" });
    await workflowSpec({ task_id: task.task.id, problem_statement: "Problem statement", success_criteria: ["c"] });
    await workflowPlan({ task_id: task.task.id, milestones: ["m"] });
    await workflowBuild({ task_id: task.task.id, changes: ["x"], files: ["f.js"], verification: ["ok"] });
    await workflowTesting({ task_id: task.task.id, test_plan: ["p"], test_results: ["r"] });

    // Simulate a legacy/manual silent skip: strip the auto-waiver from evaluate.
    const before = getOrchestrationTask({ id: task.task.id });
    const evaluate = before.task.stages.find((s) => s.stage === "evaluate");
    expect(evaluate.status).toBe("pending");
    const stateFile = process.env.PONYOU_ORCH_FILE;
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    raw.tasks.find((t) => t.id === task.task.id).stages.find((s) => s.stage === "evaluate").notes = [];
    fs.writeFileSync(stateFile, JSON.stringify(raw));

    const blocked = validateTaskPolicy({ task_id: task.task.id, pending_agent: "claude" });
    expect(blocked.passes).toBe(false);
    expect(blocked.issues.join(" ")).toMatch(/skipped silently/);

    // A recorded waiver downgrades the skip to a warning and unblocks the gate.
    addOrchestrationNote({ id: task.task.id, stage: "evaluate", note: "waiver: evaluate folded into decide", agent: "claude" });
    const allowed = validateTaskPolicy({ task_id: task.task.id, pending_agent: "claude" });
    expect(allowed.passes).toBe(true);
    expect(allowed.warnings.join(" ")).toMatch(/waiver/);
  });
});
