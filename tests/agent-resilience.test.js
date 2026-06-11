/**
 * Tests for sub-agent resilience fixes:
 *  - pro-orchestrator: configurable thresholds, validation shadow mode
 *  - hunters-agent: source threshold offset logic, dashboard shape
 */
import { describe, it, expect, beforeEach } from "vitest";
import { config } from "../config.js";

import {
  proBuyDecision,
  isProValidationMode,
  getProDashboard,
} from "../agents/pro-orchestrator.js";

import {
  getSourceMinScore,
  getHuntersDashboard,
  HUNTER_SCHEDULE,
} from "../agents/hunters-agent.js";

describe("pro-orchestrator: proBuyDecision threshold convergence", () => {
  const strongCandidate = {
    conviction: { conviction_score: 80 },
    signal: { aggregate: 70 },
    kelly: { effective_fraction: 0.15, should_skip: false },
    workflow: { verdict: "active" },
    rugScore: 10,
    marketCondition: "HOT",
    narrativeVelocity: { detected: true },
    volatilityPercentile: 40,
    liquidity: 50000,
  };

  const weakCandidate = {
    conviction: { conviction_score: 30 },
    signal: { aggregate: 20 },
    kelly: { effective_fraction: 0.01, should_skip: true },
    workflow: { verdict: "skip" },
    rugScore: 60,
    marketCondition: "COLD",
    narrativeVelocity: { detected: false },
    volatilityPercentile: 90,
    liquidity: 500,
  };

  it("returns BUY when enough signals converge", () => {
    const result = proBuyDecision(strongCandidate);
    expect(result.action).toBe("BUY");
    expect(result.convergingSignals).toBeGreaterThanOrEqual(result.requiredSignals);
  });

  it("returns SKIP when signals are weak", () => {
    const result = proBuyDecision(weakCandidate);
    expect(result.action).toBe("SKIP");
    expect(result.convergingSignals).toBeLessThan(result.requiredSignals);
  });

  it("respects config.pro threshold overrides (live, no restart)", () => {
    const original = config.pro.requiredSignals;
    try {
      // Tighten to an impossible bar — even the strong candidate should SKIP
      config.pro.requiredSignals = 99;
      const result = proBuyDecision(strongCandidate);
      expect(result.action).toBe("SKIP");
    } finally {
      config.pro.requiredSignals = original;
    }
  });

  it("respects a loosened convergence requirement", () => {
    const original = config.pro.requiredSignals;
    try {
      config.pro.requiredSignals = 1;
      // weak candidate has at least 0-1 converging; with bar=1 it may pass
      const result = proBuyDecision({ ...weakCandidate, conviction: { conviction_score: 80 } });
      expect(result.requiredSignals).toBe(1);
    } finally {
      config.pro.requiredSignals = original;
    }
  });
});

describe("pro-orchestrator: validation shadow mode", () => {
  it("isProValidationMode is callable and returns a boolean", () => {
    expect(typeof isProValidationMode()).toBe("boolean");
  });

  it("getProDashboard exposes active + validation state", () => {
    const dash = getProDashboard();
    expect(dash).toBeDefined();
    expect(dash).toHaveProperty("agent");
  });
});

describe("hunters-agent: source threshold offsets", () => {
  it("returns base score when no offset is set", () => {
    expect(getSourceMinScore("unknown_source_xyz", 30)).toBe(30);
  });

  it("HUNTER_SCHEDULE has all regime entries", () => {
    for (const regime of ["EXTREME", "HOT", "NORMAL", "COLD", "DEAD"]) {
      expect(HUNTER_SCHEDULE[regime]).toBeDefined();
      expect(HUNTER_SCHEDULE[regime]).toHaveProperty("active");
    }
  });

  it("DEAD and EXTREME regimes are inactive (no hunting)", () => {
    expect(HUNTER_SCHEDULE.DEAD.active).toBe(false);
    expect(HUNTER_SCHEDULE.EXTREME.active).toBe(false);
  });

  it("HOT regime casts a wide net (low minScore, high maxTokens)", () => {
    expect(HUNTER_SCHEDULE.HOT.active).toBe(true);
    expect(HUNTER_SCHEDULE.HOT.minScore).toBeLessThanOrEqual(HUNTER_SCHEDULE.COLD.minScore);
    expect(HUNTER_SCHEDULE.HOT.maxTokens).toBeGreaterThanOrEqual(HUNTER_SCHEDULE.COLD.maxTokens);
  });

  it("getHuntersDashboard returns schedule + stats shape", () => {
    const dash = getHuntersDashboard();
    expect(dash).toHaveProperty("agent");
    expect(dash).toHaveProperty("schedule");
  });
});

// ─── HA-2: gate-block recovery ──────────────────────────────────────
// A gate block (learning mode / rug breaker / kill switch) freezes the
// hunting schedule via `hunters:gate_blocked`. Before HA-2 nothing ever
// un-froze it (market:update fires once at startup; screening only
// commands on regime CHANGE), so one temporary pause killed the intake
// pipeline until process restart.
import {
  onHuntersGateBlocked,
  onHuntersGateCleared,
  recoverHuntingIfGateBlocked,
} from "../agents/hunters-agent.js";

describe("hunters-agent: gate-block recovery (HA-2)", () => {
  it("gate_blocked freezes the schedule with a gateBlock marker", () => {
    onHuntersGateBlocked({ reason: "LEARNING_MODE: resume in 2min", timestamp: Date.now() });
    const s = getHuntersDashboard().agent.schedule;
    expect(s.active).toBe(false);
    expect(s.gateBlock).toBe(true);
    expect(s.reason).toContain("LEARNING_MODE");
  });

  it("gate_cleared restores hunting immediately", () => {
    onHuntersGateBlocked({ reason: "LEARNING_MODE: resume in 2min", timestamp: Date.now() });
    onHuntersGateCleared();
    const s = getHuntersDashboard().agent.schedule;
    expect(s.active).toBe(true);
    expect(s.gateBlock).toBeUndefined();
  });

  it("does NOT auto-recover before the stale window without force", () => {
    const now = Date.now();
    onHuntersGateBlocked({ reason: "RUG_CIRCUIT_BREAKER: wave", timestamp: now });
    expect(recoverHuntingIfGateBlocked({ now: now + 5 * 60_000 })).toBe(false);
    expect(getHuntersDashboard().agent.schedule.active).toBe(false);
  });

  it("self-heals a gate block older than 15 minutes", () => {
    const now = Date.now();
    onHuntersGateBlocked({ reason: "RUG_CIRCUIT_BREAKER: wave", timestamp: now });
    expect(recoverHuntingIfGateBlocked({ now: now + 16 * 60_000 })).toBe(true);
    const s = getHuntersDashboard().agent.schedule;
    expect(s.active).toBe(true);
    expect(s.gateBlock).toBeUndefined();
  });

  it("recovery is a no-op when nothing is gate-blocked", () => {
    onHuntersGateCleared(); // ensure unfrozen
    expect(recoverHuntingIfGateBlocked({ force: true })).toBe(false);
  });
});
