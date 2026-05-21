import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrategyRegistry } from "../strategy-registry.js";

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-strategy-registry-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function persistPath(name = "strategy-registry.json") {
  return path.join(tempDir, name);
}

describe("StrategyRegistry", () => {
  it("registers a candidate and returns it by id", () => {
    const registry = new StrategyRegistry({ persistPath: null });

    const id = registry.register({
      name: "three candle hot",
      type: "select",
      rules: { signal: "three_candle" },
    });

    const record = registry.get(id);
    expect(record).toMatchObject({
      id,
      name: "three candle hot",
      type: "select",
      status: "candidate",
      source: "manual",
      rules: { signal: "three_candle" },
    });
    expect(record.createdAt).toEqual(expect.any(String));
  });

  it("activates a candidate with an evidence snapshot", () => {
    const registry = new StrategyRegistry({ persistPath: null });
    const id = registry.register({ name: "hybrid", type: "compose", rules: {} });

    registry.activate(id, {
      backtest: 0.85,
      paper: 0.82,
      live: 0.81,
      evidence: { trades: 150 },
    });

    const record = registry.get(id);
    expect(record.status).toBe("active");
    expect(record.scores).toMatchObject({ backtest: 0.85, paper: 0.82, live: 0.81 });
    expect(record.evidence).toMatchObject({ trades: 150 });
    expect(record.activatedAt).toEqual(expect.any(String));
  });

  it("rejects a candidate with a reason", () => {
    const registry = new StrategyRegistry({ persistPath: null });
    const id = registry.register({ name: "generated", type: "generate", rules: {} });

    registry.reject(id, "backtest win rate 0.65 < 0.80");

    const record = registry.get(id);
    expect(record.status).toBe("rejected");
    expect(record.rejectReason).toMatch("backtest");
  });

  it("deactivates an active strategy as superseded", () => {
    const registry = new StrategyRegistry({ persistPath: null });
    const id = registry.register({ name: "legacy", type: "select", rules: {} });

    registry.activate(id, { live: 0.83 });
    registry.deactivate(id, "degraded below 75%");

    const record = registry.get(id);
    expect(record.status).toBe("superseded");
    expect(record.deactivationReason).toBe("degraded below 75%");
    expect(record.deactivatedAt).toEqual(expect.any(String));
  });

  it("getBestActive returns the highest-scoring active strategy for a regime", () => {
    const registry = new StrategyRegistry({ persistPath: null });
    const slow = registry.register({ name: "slow", type: "select", rules: {}, regime: "HOT" });
    const fast = registry.register({ name: "fast", type: "select", rules: {}, regime: "HOT" });
    const cold = registry.register({ name: "cold", type: "select", rules: {}, regime: "COLD" });

    registry.activate(slow, { live: 0.82 });
    registry.activate(fast, { live: 0.91 });
    registry.activate(cold, { live: 0.99 });

    expect(registry.getBestActive("HOT")?.id).toBe(fast);
  });

  it("persists records and loads them on the next registry instance", () => {
    const file = persistPath();
    const first = new StrategyRegistry({ persistPath: file });
    const id = first.register({
      name: "persisted",
      type: "select",
      rules: { signal: "conviction" },
      regime: "NORMAL",
    });
    first.activate(id, { live: 0.88 });

    const second = new StrategyRegistry({ persistPath: file });

    expect(second.get(id)).toMatchObject({
      id,
      name: "persisted",
      status: "active",
      regime: "NORMAL",
      scores: { live: 0.88 },
    });
    expect(second.getAll()).toHaveLength(1);
  });

  it("does not expose mutable internal records", () => {
    const registry = new StrategyRegistry({ persistPath: null });
    const id = registry.register({ name: "immutable", type: "select", rules: {} });

    const record = registry.get(id);
    record.status = "active";

    expect(registry.get(id).status).toBe("candidate");
  });
});
