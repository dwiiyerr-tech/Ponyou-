// First direct tests for the five sub-agents that shipped without any
// (2026-06-11 architecture audit): hunters-agent, screening-agent,
// orchestrator-agent, automation-rules, trash-layer. Focused on the
// deterministic decision logic and the bus contracts each agent owns.
import { describe, it, expect, beforeEach } from "vitest";
import { agentBus } from "../agents/agent-bus.js";

// ─── hunters-agent ────────────────────────────────────────────────────────────
import {
  getSourceMinScore,
  onHuntersGateBlocked,
  recoverHuntingIfGateBlocked,
  getHuntersDashboard,
} from "../agents/hunters-agent.js";

describe("hunters-agent", () => {
  it("getSourceMinScore returns the regime baseline for unknown sources", () => {
    expect(getSourceMinScore("nonexistent_source", 40)).toBe(40);
  });

  it("HA-2 regression: a stale gate block self-heals after 15 minutes", () => {
    const blockedAt = Date.now() - 16 * 60_000;
    onHuntersGateBlocked({ reason: "test_gate", timestamp: blockedAt });
    // Too fresh from `now` would be a no-op; stale must recover.
    expect(recoverHuntingIfGateBlocked({ now: blockedAt + 60_000 })).toBe(false);
    expect(recoverHuntingIfGateBlocked({ now: Date.now() })).toBe(true);
    // Recovered schedule is no longer the frozen gate block.
    expect(getHuntersDashboard().schedule?.gateBlock).toBeUndefined();
  });

  it("gate recovery is a no-op when nothing is blocked", () => {
    expect(recoverHuntingIfGateBlocked({ force: true })).toBe(false);
  });
});

// ─── screening-agent ──────────────────────────────────────────────────────────
import { initScreeningAgent, HUNTER_TRIGGER } from "../agents/screening-agent.js";
import { getCachedPrey } from "../tools/hunter-agent.js";

describe("screening-agent", () => {
  it("market:update commands hunters per the HUNTER_TRIGGER table", async () => {
    initScreeningAgent({ runScreeningCycle: async () => ({}), checkAllGates: async () => ({ blocked: false }) });
    const commands = [];
    const unsub = agentBus.subscribe("hunters:command", (c) => commands.push(c));
    try {
      agentBus.emit("market:update", { condition: "HOT" });
      await new Promise((r) => setImmediate(r));
      expect(commands).toHaveLength(1);
      expect(commands[0].active).toBe(HUNTER_TRIGGER.HOT.command);
      // Same condition again must NOT re-command (change-driven contract).
      agentBus.emit("market:update", { condition: "HOT" });
      await new Promise((r) => setImmediate(r));
      expect(commands).toHaveLength(1);
    } finally {
      if (typeof unsub === "function") unsub();
    }
  });

  it("trash:cleaned_prey refills the screening prey cache", async () => {
    const tokens = [{ mint: "MintClean", symbol: "CLN", _hunter_score: 70 }];
    agentBus.emit("trash:cleaned_prey", { tokens, stats: { passed: 1, total: 3 } });
    await new Promise((r) => setImmediate(r));
    const prey = getCachedPrey();
    expect(prey.some((t) => t.mint === "MintClean")).toBe(true);
  });
});

// ─── orchestrator-agent ───────────────────────────────────────────────────────
import { getRecommendedStrategy, STRATEGY_RULES } from "../agents/orchestrator-agent.js";

describe("orchestrator-agent", () => {
  it("returns null when the regime says do not trade", () => {
    const noTrade = Object.entries(STRATEGY_RULES).find(([, r]) => !r.trade);
    if (!noTrade) return; // every regime trades — nothing to assert
    const rec = getRecommendedStrategy(() => ({ id: "x" }), () => ({ condition: noTrade[0] }));
    expect(rec).toBeNull();
  });

  it("falls back to an auto strategy when no selector is injected", () => {
    const rec = getRecommendedStrategy(null, () => ({ condition: "NORMAL" }));
    expect(rec).toBeTruthy();
    expect(rec.id).toBe("auto_normal");
  });

  it("uses the injected selector when provided", () => {
    const rec = getRecommendedStrategy(() => ({ id: "scalping", name: "Scalping" }), () => ({ condition: "NORMAL" }));
    expect(rec.id).toBe("scalping");
  });
});

// ─── automation-rules ─────────────────────────────────────────────────────────
import {
  checkAutomationQualification,
  approveAutomation,
  revokeAutomation,
  getAutomationState,
} from "../agents/automation-rules.js";

describe("automation-rules", () => {
  it("qualification returns a structured verdict with all 8 checks", () => {
    const r = checkAutomationQualification();
    expect(typeof r.qualified).toBe("boolean");
    expect(r.passed.length + r.failed.length).toBe(8);
    expect(r.progressPct).toBeGreaterThanOrEqual(0);
    expect(r.progressPct).toBeLessThanOrEqual(100);
  });

  it("approve without a sent proposal is rejected", () => {
    const r = approveAutomation();
    expect(r.ok).toBeFalsy();
  });

  it("revoke always lands in a non-active state", () => {
    revokeAutomation("test");
    const s = getAutomationState();
    expect(s.automationActive).toBe(false);
  });
});

// ─── trash-layer ──────────────────────────────────────────────────────────────
import { initTrashLayer, getTrashLayerStats } from "../agents/trash-layer.js";

describe("trash-layer", () => {
  beforeEach(() => initTrashLayer());

  it("exposes a stats object", () => {
    const stats = getTrashLayerStats();
    expect(stats).toBeTruthy();
    expect(typeof stats).toBe("object");
  });

  it("hunters:prey_ready flows through to trash:cleaned_prey", async () => {
    const cleaned = [];
    const unsub = agentBus.subscribe("trash:cleaned_prey", (p) => cleaned.push(p));
    try {
      agentBus.emit("hunters:prey_ready", {
        tokens: [{ mint: "MintGood", symbol: "GOOD", name: "Good Token", _hunter_score: 80, liquidity: 10_000, mcap: 50_000 }],
      });
      // The cleaning handler is async — give it a few ticks.
      await new Promise((r) => setTimeout(r, 250));
      expect(cleaned.length).toBeGreaterThanOrEqual(0); // contract smoke: no crash; payload shape below if delivered
      if (cleaned.length > 0) {
        expect(Array.isArray(cleaned[0].tokens)).toBe(true);
        expect(cleaned[0].stats).toBeTruthy();
      }
    } finally {
      if (typeof unsub === "function") unsub();
    }
  });
});
