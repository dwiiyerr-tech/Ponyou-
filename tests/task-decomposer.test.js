import { describe, it, expect } from "vitest";
import { routeTask, decomposeTask, decomposeAll, AGENTS } from "../task-decomposer.js";

describe("routeTask", () => {
  it("routes research tasks to gemini", () => {
    expect(routeTask("research gap pattern in agent logs")).toBe(AGENTS.GEMINI);
    expect(routeTask("analisis failure modes")).toBe(AGENTS.GEMINI);
  });

  it("routes review/finalize to claude", () => {
    expect(routeTask("review and finalize the PR")).toBe(AGENTS.CLAUDE);
    expect(routeTask("evaluate the gate output")).toBe(AGENTS.CLAUDE);
  });

  it("routes implement/build/fix to codex by default", () => {
    expect(routeTask("implement gap-detector.js")).toBe(AGENTS.CODEX);
    expect(routeTask("write unit tests for task-decomposer")).toBe(AGENTS.CODEX);
    expect(routeTask("fix import error in index.js")).toBe(AGENTS.CODEX);
  });
});

describe("decomposeTask", () => {
  it("returns atomic task unchanged", () => {
    const result = decomposeTask("implement gap-detector.js");
    expect(result.isAtomic).toBe(true);
    expect(result.subTasks).toHaveLength(1);
    expect(result.subTasks[0].text).toBe("implement gap-detector.js");
    expect(result.subTasks[0].agent).toBe(AGENTS.CODEX);
  });

  it("splits semicolon-separated tasks", () => {
    const result = decomposeTask("research failure modes; implement fix; review results");
    expect(result.isAtomic).toBe(false);
    expect(result.subTasks).toHaveLength(3);
    expect(result.subTasks[0].agent).toBe(AGENTS.GEMINI);
    expect(result.subTasks[1].agent).toBe(AGENTS.CODEX);
    expect(result.subTasks[2].agent).toBe(AGENTS.CLAUDE);
  });

  it("splits plus-separated tasks", () => {
    const result = decomposeTask("implement module A + write tests");
    expect(result.subTasks.length).toBeGreaterThan(1);
  });

  it("caps at maxSubTasks", () => {
    const task = "a; b; c; d; e; f; g";
    const result = decomposeTask(task, { maxSubTasks: 3 });
    expect(result.subTasks.length).toBeLessThanOrEqual(3);
  });
});

describe("decomposeAll", () => {
  it("decomposes array of tasks", () => {
    const tasks = ["research patterns", "implement fix", "review"];
    const results = decomposeAll(tasks);
    expect(results).toHaveLength(3);
    expect(results[0].agent).toBe(AGENTS.GEMINI);
    expect(results[1].agent).toBe(AGENTS.CODEX);
    expect(results[2].agent).toBe(AGENTS.CLAUDE);
  });
});
