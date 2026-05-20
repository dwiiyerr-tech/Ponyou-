import { afterEach, describe, expect, it } from "vitest";
import { _resetExperimentsForTests, createExperiment } from "../infra/agent-collab/experiment-tracker.js";
import {
  _resetOrchestrationForTests,
  createOrchestrationTask,
  getOrchestrationTask,
} from "../infra/agent-collab/agent-orchestrator.js";
import { _resetSemanticMemoryForTests } from "../infra/agent-collab/semantic-memory.js";
import {
  autoSubmitWorkerResult,
  _resetWorkflowArtifactsForTests,
  getWorkflowArtifacts,
  workflowBrainstorm,
  workflowBuild,
  workflowPlan,
  workflowResearch,
  workflowSpec,
  workflowTesting,
} from "../infra/agent-collab/workflow-bridge.js";

afterEach(() => {
  _resetExperimentsForTests();
  _resetOrchestrationForTests();
  _resetSemanticMemoryForTests();
  _resetWorkflowArtifactsForTests();
});

describe("workflow bridge", () => {
  it("runs research and advances the task to evaluate", async () => {
    const experiment = createExperiment({
      name: "Narrative gate",
      hypothesis: "AI should stay overweight in HOT markets",
      baseline_rule: "neutral weighting",
      candidate_rule: "ai overweight",
    });

    const task = createOrchestrationTask({
      title: "Research AI overweight",
      objective: "Evaluate whether AI should stay overweight.",
      experiment_id: experiment.id,
      candidate: { symbol: "AIX", market_condition: "HOT", narrative: "AI" },
    });

    const result = await workflowResearch({
      task_id: task.task.id,
      findings: ["AI names still dominate volume."],
      counter_arguments: ["Rotation risk is rising."],
      unknowns: ["Need deeper holder stability check."],
      recommendation_for_claude: "Proceed to technical evaluation with caution.",
    });

    expect(result.artifact.kind).toBe("research");
    expect(result.task.task.current_stage).toBe("evaluate");
  });

  it("records spec, plan, build, and testing artifacts", async () => {
    const task = createOrchestrationTask({
      title: "Upgrade execution route",
      objective: "Assess and implement a safer split-route default.",
    });

    await workflowSpec({
      task_id: task.task.id,
      problem_statement: "Execution quality varies by route.",
      success_criteria: ["Improve quality score", "No regression in slippage"],
      constraints: ["Do not change core risk decision logic"],
    });

    await workflowPlan({
      task_id: task.task.id,
      milestones: ["Measure current route quality", "Implement route selection change"],
      risks: ["Route instability under high congestion"],
      rollout_strategy: "Gate behind feature flag first.",
    });

    const built = await workflowBuild({
      task_id: task.task.id,
      changes: ["Added split-route preference for HOT markets"],
      files: ["tools/executor.js", "execution-quality-memory.js"],
      verification: ["Unit tests updated", "Manual dry-run verified"],
    });

    await workflowTesting({
      task_id: task.task.id,
      test_plan: ["Run route selection suite", "Run dry-run scenario"],
      test_results: ["Route selection suite passed", "Dry-run passed"],
      failures: [],
    });

    const artifacts = getWorkflowArtifacts({ task_id: task.task.id });
    const freshTask = getOrchestrationTask({ id: task.task.id });

    expect(artifacts.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["spec", "plan", "build", "testing"])
    );
    expect(built.task.task.current_stage).toBe("decide");
    expect(freshTask.task.current_stage).toBe("decide");
  });

  it("records brainstorming artifacts without disturbing the active stage", async () => {
    const task = createOrchestrationTask({
      title: "Brainstorm route safety",
      objective: "Identify the safest direction for route selection changes.",
    });

    const result = await workflowBrainstorm({
      task_id: task.task.id,
      idea: "Use route-aware switching under HOT regimes.",
      goals: ["Lower slippage", "Keep rollout reversible"],
      alternatives: ["Threshold tuning only", "Route blacklist"],
      open_questions: ["Does congestion dominate route quality?"],
    });

    expect(result.artifact.kind).toBe("brainstorm");
    expect(result.task.task.current_stage).toBe("research");
  });

  it("auto-submits Gemini and Codex worker results into the right artifacts", async () => {
    const task = createOrchestrationTask({
      title: "Route quality upgrade",
      objective: "Research and validate a route-aware improvement.",
    });

    const research = await autoSubmitWorkerResult({
      task_id: task.task.id,
      worker: "gemini",
      findings: ["Route A remains strongest in HOT regimes."],
      counter_arguments: ["Congestion may erase the edge."],
      unknowns: ["Need route-specific slippage samples."],
      confidence: 0.72,
      recommendation_for_claude: "Proceed to technical evaluation.",
    });

    expect(research.artifact.kind).toBe("research");
    expect(research.task.task.current_stage).toBe("evaluate");

    const buildAndTest = await autoSubmitWorkerResult({
      task_id: task.task.id,
      worker: "codex",
      technical_plan_or_change: ["Add route-aware selector behind feature flag."],
      files_or_modules_affected: ["tools/executor.js", "execution-quality-memory.js"],
      verification: ["Unit test coverage updated", "Dry run checked"],
      risks: ["Possible route instability during congestion"],
      questions_for_claude: ["Should rollout stay HOT-only first?"],
      test_plan: ["Run route quality suite", "Run dry mode scenario"],
      test_results: ["Route quality suite passed", "Dry mode scenario passed"],
      failures: [],
      coverage_notes: ["No live order path exercised yet"],
    });

    const artifacts = getWorkflowArtifacts({ task_id: task.task.id });
    expect(artifacts.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["research", "build", "testing"])
    );
    expect(buildAndTest.task.task.current_stage).toBe("decide");
  });
});
