import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _resetExperimentsForTests, createExperiment } from "../infra/agent-collab/experiment-tracker.js";
import {
  _resetOrchestrationForTests,
  advanceOrchestrationTask,
  createOrchestrationTask,
} from "../infra/agent-collab/agent-orchestrator.js";

const execFileAsync = promisify(execFile);

afterEach(() => {
  _resetExperimentsForTests();
  _resetOrchestrationForTests();
});

describe("collab control commands", () => {
  it("prints handoffs and next task for Claude remote control", async () => {
    const experiment = createExperiment({
      name: "Probe Tightening",
      hypothesis: "Lower rug threshold improves quality",
      baseline_rule: "rug_score<35",
      candidate_rule: "rug_score<28",
    });

    const created = createOrchestrationTask({
      title: "Decide probe tightening",
      objective: "Use research and evaluation to decide whether to adopt the new gate.",
      experiment_id: experiment.id,
    });

    advanceOrchestrationTask({
      id: created.task.id,
      next_stage: "evaluate",
      note: "research done",
      agent: "gemini",
    });
    advanceOrchestrationTask({
      id: created.task.id,
      next_stage: "decide",
      note: "technical evaluation done",
      agent: "codex",
    });

    const handoffs = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-handoffs.js",
      "--owner",
      "claude",
    ], { cwd: "/home/ubuntu/ponyou" });
    const next = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-next.js",
      "--owner",
      "claude",
    ], { cwd: "/home/ubuntu/ponyou" });

    const parsedHandoffs = JSON.parse(handoffs.stdout);
    const parsedNext = JSON.parse(next.stdout);

    expect(parsedHandoffs.count).toBe(1);
    expect(parsedHandoffs.handoffs[0].owner).toBe("claude");
    expect(parsedNext.next.stage).toBe("decide");
    expect(parsedNext.next.experiment_id).toBe(experiment.id);
  });

  it("emits a ready-to-send worker prompt for Codex", async () => {
    const experiment = createExperiment({
      name: "Execution Route Review",
      hypothesis: "Split routes may improve execution quality",
      baseline_rule: "split=false",
      candidate_rule: "split=true",
    });

    const created = createOrchestrationTask({
      title: "Evaluate execution route",
      objective: "Assess whether split routing should be adopted.",
      experiment_id: experiment.id,
      candidate: { symbol: "XYZ", market_condition: "HOT" },
    });

    advanceOrchestrationTask({
      id: created.task.id,
      next_stage: "evaluate",
      note: "ready for technical evaluation",
      agent: "gemini",
    });

    const next = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-next.js",
      "--owner",
      "codex",
      "--for",
      "codex",
    ], { cwd: "/home/ubuntu/ponyou" });

    const parsed = JSON.parse(next.stdout);
    expect(parsed.worker).toBe("codex");
    expect(parsed.prompt).toContain("You are working as Codex");
    expect(parsed.prompt).toContain("Objective: Assess whether split routing should be adopted.");
    expect(parsed.prompt).toContain("auto_submit_worker_result");
  });

  it("prints summarized status output", async () => {
    createOrchestrationTask({
      title: "Task one",
      objective: "First objective",
    });

    const status = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-status.js",
    ], { cwd: "/home/ubuntu/ponyou" });

    const parsed = JSON.parse(status.stdout);
    expect(parsed.tasks.total).toBeGreaterThan(0);
    expect(Array.isArray(parsed.tasks.top)).toBe(true);
  });

  it("dispatches a plain worker prompt for Gemini", async () => {
    const experiment = createExperiment({
      name: "Narrative Review",
      hypothesis: "AI narratives remain dominant in HOT markets",
      baseline_rule: "narrative neutral weighting",
      candidate_rule: "AI overweight in HOT regimes",
    });

    createOrchestrationTask({
      title: "Research AI narrative strength",
      objective: "Check whether AI narrative still deserves priority weighting.",
      experiment_id: experiment.id,
      candidate: { symbol: "AIX", market_condition: "HOT", narrative: "AI" },
    });

    const dispatched = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-dispatch.js",
      "--to",
      "gemini",
    ], { cwd: "/home/ubuntu/ponyou" });

    expect(dispatched.stdout).toContain("You are working as Gemini");
    expect(dispatched.stdout).toContain("Objective: Check whether AI narrative still deserves priority weighting.");
  });

  it("prints startup control surface for Claude remote operation", async () => {
    const experiment = createExperiment({
      name: "Gate Decision",
      hypothesis: "Tighter gates improve quality",
      baseline_rule: "old gate",
      candidate_rule: "new gate",
    });

    const claudeTask = createOrchestrationTask({
      title: "Make gate decision",
      objective: "Decide whether to adopt the tighter gate.",
      experiment_id: experiment.id,
    });
    advanceOrchestrationTask({
      id: claudeTask.task.id,
      next_stage: "decide",
      note: "ready for Claude decision",
      agent: "codex",
    });

    createOrchestrationTask({
      title: "Research memecoin theme",
      objective: "Check whether AI meme theme is still hot.",
    });

    const start = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-start.js",
    ], { cwd: "/home/ubuntu/ponyou" });

    const parsed = JSON.parse(start.stdout);
    expect(parsed.status.tasks_total).toBeGreaterThan(0);
    expect(parsed.claude.next.title).toBe("Make gate decision");
    expect(parsed.gemini.next.title).toBe("Research memecoin theme");
  });

  it("submits fallback Gemini results through the CLI command", async () => {
    const created = createOrchestrationTask({
      title: "Research holder stability",
      objective: "Check whether holder structure is stable enough for a probe.",
    });

    const submitted = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-submit.js",
      "--task-id",
      String(created.task.id),
      "--worker",
      "gemini",
      "--findings",
      "Top holders look stable,Volume remains healthy",
      "--counter-arguments",
      "Rotation risk is rising",
      "--unknowns",
      "Need deployer cross-check",
      "--confidence",
      "0.68",
      "--recommendation",
      "Proceed to technical evaluation.",
    ], { cwd: "/home/ubuntu/ponyou" });

    const parsed = JSON.parse(submitted.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.worker).toBe("gemini");
    expect(parsed.result.artifact.kind).toBe("research");
    expect(parsed.result.task.task.current_stage).toBe("evaluate");
  });

  it("submits fallback Codex results through the CLI command", async () => {
    const created = createOrchestrationTask({
      title: "Evaluate route selector",
      objective: "Validate whether route-aware selection is safe to adopt.",
    });

    advanceOrchestrationTask({
      id: created.task.id,
      next_stage: "evaluate",
      note: "ready for Codex",
      agent: "gemini",
    });

    const submitted = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-submit.js",
      "--task-id",
      String(created.task.id),
      "--worker",
      "codex",
      "--technical-plan-or-change",
      "Added route-aware selector behind feature flag",
      "--files-or-modules-affected",
      "tools/executor.js,execution-quality-memory.js",
      "--verification",
      "Unit tests updated,Dry run checked",
      "--risks",
      "Route quality may degrade under congestion",
      "--questions-for-claude",
      "Should rollout remain HOT-only first",
      "--test-plan",
      "Run route suite,Run dry mode",
      "--test-results",
      "Route suite passed,Dry mode passed",
      "--coverage-notes",
      "No live order path exercised",
    ], { cwd: "/home/ubuntu/ponyou" });

    const parsed = JSON.parse(submitted.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.worker).toBe("codex");
    expect(parsed.result.artifacts).toHaveLength(2);
    expect(parsed.result.task.task.current_stage).toBe("decide");
  });

  it("triages upgrade ideas from experiments and memory", async () => {
    const experiment = createExperiment({
      name: "Weak Candidate",
      hypothesis: "Aggressive sizing helps",
      baseline_rule: "size=1x",
      candidate_rule: "size=1.5x",
    });
    const { recordExperimentRun } = await import("../infra/agent-collab/experiment-tracker.js");
    await recordExperimentRun({
      experiment_id: experiment.id,
      variant: "baseline",
      sample_size: 20,
      wins: 11,
      losses: 9,
      pnl_pct: 8,
      max_drawdown_pct: 10,
    });
    await recordExperimentRun({
      experiment_id: experiment.id,
      variant: "candidate",
      sample_size: 20,
      wins: 8,
      losses: 12,
      pnl_pct: -4,
      max_drawdown_pct: 18,
    });

    const triage = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-triage.js",
    ], { cwd: "/home/ubuntu/ponyou" });

    const parsed = JSON.parse(triage.stdout);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.ideas.some((item) => item.type === "experiment_regression")).toBe(true);
  });
});
