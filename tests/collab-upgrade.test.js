import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _resetExperimentsForTests } from "../infra/agent-collab/experiment-tracker.js";
import { _resetOrchestrationForTests } from "../infra/agent-collab/agent-orchestrator.js";
import { _resetSemanticMemoryForTests } from "../infra/agent-collab/semantic-memory.js";
import { _resetWorkflowArtifactsForTests, getWorkflowArtifacts } from "../infra/agent-collab/workflow-bridge.js";

const execFileAsync = promisify(execFile);

afterEach(() => {
  _resetExperimentsForTests();
  _resetOrchestrationForTests();
  _resetSemanticMemoryForTests();
  _resetWorkflowArtifactsForTests();
});

describe("collab:upgrade", () => {
  it("creates experiment, orchestration task, spec, and plan in one command", async () => {
    const { stdout } = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/collab-upgrade.js",
      "--title", "Upgrade route selection",
      "--objective", "Improve execution quality in HOT conditions",
      "--hypothesis", "Route-aware logic improves fill quality",
      "--baseline-rule", "current route selection",
      "--candidate-rule", "route-aware split preference",
      "--problem-statement", "Current route logic ignores market condition.",
      "--success-criteria", "quality score up,no slippage regression",
      "--constraints", "do not change risk gate,feature flag only",
      "--acceptance-checks", "tests pass,dry-run clean",
      "--milestones", "measure baseline,implement logic,run tests",
      "--risks", "route instability,slippage regression",
      "--rollout-strategy", "feature flag then staged rollout",
    ], {
      cwd: "/home/ubuntu/ponyou",
    });

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.experiment_id).toBe(1);
    expect(parsed.task_id).toBe(1);
    expect(parsed.artifacts.spec_id).toBeTruthy();
    expect(parsed.artifacts.plan_id).toBeTruthy();

    const artifacts = getWorkflowArtifacts({ task_id: parsed.task_id });
    expect(artifacts.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["spec", "plan"])
    );
  });
});
