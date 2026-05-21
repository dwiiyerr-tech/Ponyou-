import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrategyEvolutionEngine } from "../strategy-evolution-engine.js";
import { StrategyEvolutionBus } from "../strategy-evolution-bus.js";
import { StrategyRegistry } from "../strategy-registry.js";

function makePassingGate(scores = { backtest: 0.90, paper: 0.88, live: 0.85 }) {
  return { evaluate: vi.fn(async () => ({ passed: true, failedLayer: null, rejectReason: null, scores, evidence: {} })) };
}
function makeFailingGate(layer = 1, reason = "backtest 0.65 < 0.80") {
  return { evaluate: vi.fn(async () => ({ passed: false, failedLayer: layer, rejectReason: reason, scores: {}, evidence: null })) };
}
function makeProposal(status = "approved") {
  return { submit: vi.fn(async () => ({ id: "any", autoApproved: true, status })), handleOperatorResponse: vi.fn() };
}

describe("StrategyEvolutionEngine", () => {
  it("activates strategy after gate pass + proposal approve", async () => {
    const bus = new StrategyEvolutionBus();
    const registry = new StrategyRegistry({ persistPath: null });
    const engine = new StrategyEvolutionEngine({ bus, registry, gate: makePassingGate(), proposal: makeProposal("approved") });
    engine.start();
    await bus.enqueue({ id: "e1", name: "test-strat", type: "select", rules: { signal: "three_candle" }, conviction: 0.97 });
    await new Promise(r => setTimeout(r, 60));
    const activated = registry.getAll().find(r => r.status === "active");
    expect(activated).toBeDefined();
    expect(activated.name).toBe("test-strat");
  });

  it("rejects strategy after gate fail — proposal not called", async () => {
    const bus = new StrategyEvolutionBus();
    const registry = new StrategyRegistry({ persistPath: null });
    const proposal = makeProposal("approved");
    const engine = new StrategyEvolutionEngine({ bus, registry, gate: makeFailingGate(1, "backtest 0.65 < 0.80"), proposal });
    engine.start();
    await bus.enqueue({ id: "e2", name: "fail-strat", type: "generate", rules: {}, conviction: 0.80 });
    await new Promise(r => setTimeout(r, 60));
    const rejected = registry.getAll().find(r => r.status === "rejected");
    expect(rejected).toBeDefined();
    expect(proposal.submit).not.toHaveBeenCalled();
  });

  it("rejects strategy when proposal is rejected", async () => {
    const bus = new StrategyEvolutionBus();
    const registry = new StrategyRegistry({ persistPath: null });
    const engine = new StrategyEvolutionEngine({ bus, registry, gate: makePassingGate(), proposal: makeProposal("timeout_rejected") });
    engine.start();
    await bus.enqueue({ id: "e3", name: "rejected-strat", type: "select", rules: {}, conviction: 0.80 });
    await new Promise(r => setTimeout(r, 60));
    const rejected = registry.getAll().find(r => r.status === "rejected");
    expect(rejected?.rejectReason).toMatch("proposal");
  });

  it("checkDegradation deactivates strategy below threshold", async () => {
    const bus = new StrategyEvolutionBus();
    const registry = new StrategyRegistry({ persistPath: null });
    const id = registry.register({ name: "degrading", type: "select", rules: {} });
    registry.activate(id, { live: 0.85 });
    const engine = new StrategyEvolutionEngine({ bus, registry, gate: makePassingGate(), proposal: makeProposal(), degradationThreshold: 0.75 });
    engine.start();
    const degraded = await engine.checkDegradation({ strategyId: id, currentLiveWinRate: 0.70 });
    expect(degraded).toBe(true);
    expect(registry.get(id).status).toBe("superseded");
  });

  it("checkDegradation returns false when win rate above threshold", async () => {
    const bus = new StrategyEvolutionBus();
    const registry = new StrategyRegistry({ persistPath: null });
    const id = registry.register({ name: "healthy", type: "select", rules: {} });
    registry.activate(id, { live: 0.90 });
    const engine = new StrategyEvolutionEngine({ bus, registry, gate: makePassingGate(), proposal: makeProposal(), degradationThreshold: 0.75 });
    engine.start();
    const degraded = await engine.checkDegradation({ strategyId: id, currentLiveWinRate: 0.82 });
    expect(degraded).toBe(false);
    expect(registry.get(id).status).toBe("active");
  });
});
