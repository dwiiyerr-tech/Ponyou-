import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _resetExperimentsForTests } from "../infra/agent-collab/experiment-tracker.js";
import { _resetOrchestrationForTests } from "../infra/agent-collab/agent-orchestrator.js";

const execFileAsync = promisify(execFile);

afterEach(() => {
  _resetExperimentsForTests();
  _resetOrchestrationForTests();
});

describe("bootstrap-task CLI", () => {
  it("creates an experiment and orchestration task from one command", async () => {
    const { stdout } = await execFileAsync("node", [
      "/home/ubuntu/ponyou/infra/agent-collab/bootstrap-task.js",
      "--title", "Probe Gate Tightening",
      "--objective", "Evaluate lower rug threshold for probe entries",
      "--hypothesis", "Lower threshold reduces false positives",
      "--baseline-rule", "rug_score<35",
      "--candidate-rule", "rug_score<28",
      "--owner", "gemini",
      "--tags", "risk,probe",
      "--symbol", "ABC",
      "--market-condition", "HOT",
      "--narrative", "AI",
      "--tier", "MICRO_CAP",
    ], {
      cwd: "/home/ubuntu/ponyou",
    });

    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.experiment_id).toBe(1);
    expect(parsed.task_id).toBe(1);
    expect(parsed.task.current_stage).toBe("research");
  });
});
