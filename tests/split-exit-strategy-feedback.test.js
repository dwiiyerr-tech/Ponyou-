/**
 * Tests for:
 *   - Split exit execution (planExit splitCount > 1)
 *   - Strategy performance feedback loop in learning-agent
 *   - Trash layer blocked-token bus events
 *   - Hunter fetchDS rate-limit backoff
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

// ─── Split exit integration (via planExit) ────────────────────────────────

import { planExit } from "../tools/exit-timing-optimizer.js";

describe("EX1: planExit split logic", () => {
  it("returns split=true when position is >5% of liquidity", () => {
    const plan = planExit({
      mint: "X",
      exitReason: "takeProfit",
      positionValueUsd: 6_000,
      liquidityUsd: 50_000,  // 12% — above 5% threshold
    });
    expect(plan.split).toBe(true);
    expect(plan.splitCount).toBeGreaterThan(1);
    expect(plan.splitDelayMs).toBeGreaterThan(0);
  });

  it("returns split=false for small positions", () => {
    const plan = planExit({
      mint: "X",
      exitReason: "takeProfit",
      positionValueUsd: 100,
      liquidityUsd: 100_000,  // 0.1%
    });
    expect(plan.split).toBe(false);
    expect(plan.splitCount).toBe(1);
  });

  it("urgent exits: no delay, high slippage regardless of split", () => {
    const plan = planExit({
      mint: "X",
      exitReason: "rug_force_exit",
      positionValueUsd: 10_000,
      liquidityUsd: 50_000,
    });
    expect(plan.urgent).toBe(true);
    expect(plan.delayBeforeFirstMs).toBe(0);
    expect(plan.slippagePct).toBeGreaterThanOrEqual(5);
  });

  it("non-urgent: delays when price actively dumping", () => {
    const plan = planExit({
      mint: "X",
      exitReason: "trailingStop",
      positionValueUsd: 500,
      liquidityUsd: 200_000,
      price1mPct: -5,
    });
    expect(plan.urgent).toBe(false);
    expect(plan.delayBeforeFirstMs).toBeGreaterThan(0);
  });

  it("non-urgent: no delay when price is stable", () => {
    const plan = planExit({
      mint: "X",
      exitReason: "trailingStop",
      positionValueUsd: 500,
      liquidityUsd: 200_000,
      price1mPct: -1,
    });
    expect(plan.delayBeforeFirstMs).toBe(0);
  });

  it("splitCount is bounded by size-to-liquidity ratio", () => {
    // positionValueUsd 25K / liquidity 50K = 50% → large split needed
    const plan = planExit({
      mint: "X",
      exitReason: "takeProfit",
      positionValueUsd: 25_000,
      liquidityUsd: 50_000,
    });
    expect(plan.split).toBe(true);
    expect(plan.splitCount).toBeGreaterThan(2);
    expect(plan.splitCount).toBeLessThanOrEqual(5); // capped at 5
  });
});

// ─── Strategy performance feedback (learning-agent) ────────────────────────

const STRATEGY_PERF_FILE = path.join(process.cwd(), "strategy-performance.json");

function cleanStratFile() {
  if (fs.existsSync(STRATEGY_PERF_FILE)) fs.unlinkSync(STRATEGY_PERF_FILE);
}

describe("LA1: strategy performance feedback loop", () => {
  beforeEach(() => {
    cleanStratFile();
    vi.resetModules();
  });
  afterEach(() => {
    cleanStratFile();
    vi.resetModules();
  });

  it("getStrategyPerformance returns empty array when no data", async () => {
    const { getStrategyPerformance } = await import("../agents/learning-agent.js");
    const perf = getStrategyPerformance();
    expect(Array.isArray(perf)).toBe(true);
    expect(perf.length).toBe(0);
  });

  it("records win correctly after strategy_outcome event via agentBus", async () => {
    const { agentBus } = await import("../agents/agent-bus.js");
    const { initLearningAgent, getStrategyPerformance } = await import("../agents/learning-agent.js");

    // init registers the bus subscriber
    initLearningAgent();

    // Emit a win outcome
    agentBus.emit("management:strategy_outcome", {
      strategy_id: "smart_money",
      mint: "MINT_A",
      symbol: "AAA",
      pnl_pct: 45,
      exit_reason: "roi",
      hold_minutes: 12,
      is_rug: false,
      is_win: true,
      market_condition: "HOT",
    });

    // Give the sync subscriber a tick to process
    await new Promise(r => setTimeout(r, 20));

    const perf = getStrategyPerformance();
    const sm = perf.find(s => s.id === "smart_money");
    expect(sm).toBeTruthy();
    expect(sm.traded).toBe(1);
    expect(sm.won).toBe(1);
    expect(sm.win_rate).toBe(1);
    expect(sm.avg_pnl_pct).toBe(45);
  });

  it("records rug outcome and computes rug_rate", async () => {
    const { agentBus } = await import("../agents/agent-bus.js");
    const { initLearningAgent, getStrategyPerformance } = await import("../agents/learning-agent.js");
    initLearningAgent();

    agentBus.emit("management:strategy_outcome", {
      strategy_id: "sniper",
      pnl_pct: -95,
      is_rug: true,
      is_win: false,
      exit_reason: "rug_force_exit",
    });
    await new Promise(r => setTimeout(r, 20));

    const perf = getStrategyPerformance();
    const sniper = perf.find(s => s.id === "sniper");
    expect(sniper.rugged).toBe(1);
    expect(sniper.rug_rate).toBe(1);
    expect(sniper.win_rate).toBe(0);
  });

  it("sorts by win_rate descending", async () => {
    const { agentBus } = await import("../agents/agent-bus.js");
    const { initLearningAgent, getStrategyPerformance } = await import("../agents/learning-agent.js");
    initLearningAgent();

    // sniper: 1 rug
    agentBus.emit("management:strategy_outcome", { strategy_id: "sniper", pnl_pct: -90, is_rug: true, is_win: false });
    // smart_money: 1 win
    agentBus.emit("management:strategy_outcome", { strategy_id: "smart_money", pnl_pct: 30, is_rug: false, is_win: true });
    await new Promise(r => setTimeout(r, 30));

    const perf = getStrategyPerformance();
    const ids = perf.map(s => s.id);
    expect(ids.indexOf("smart_money")).toBeLessThan(ids.indexOf("sniper"));
  });
});

// ─── Trash layer blocked feedback ────────────────────────────────────────────
// Test the _emitTrashBlock helper by importing filterPreyAdvanced indirectly
// through the agentBus. The trash-layer module is imported once so all share
// the same agentBus singleton.

import { agentBus as _bus } from "../agents/agent-bus.js";
import { initTrashLayer } from "../agents/trash-layer.js";

describe("TL1: trash-layer block feedback via agentBus", () => {
  it("emits learning:trash_blocked when scam name blocks a token", async () => {
    // Ensure trash-layer is initialized (idempotent)
    initTrashLayer();

    const blocked = [];
    const handler = (p) => blocked.push(p);
    _bus.on("learning:trash_blocked", handler);

    // Emit prey with a token whose name matches the scam-name pattern
    _bus.emit("hunters:prey_ready", {
      prey: [{
        mint: "SCAM_MINT_TL1",
        symbol: "testcoin",   // matches /^(test|testcoin)/i at weight=8 → hard block
        name: "Test Coin",
        liquidity: 5000,
        volume: 1000,
        swaps: 10,
        mcap: 50000,
        created_at: Math.floor(Date.now() / 1000) - 3600,
        _hunt_source: "pumpfun",
      }],
      marketCondition: "NORMAL",
    });

    // Allow async filterPreyAdvanced to complete
    await new Promise(r => setTimeout(r, 200));
    _bus.off("learning:trash_blocked", handler);

    const ev = blocked.find(b => b.mint === "SCAM_MINT_TL1");
    expect(ev).toBeTruthy();
    expect(ev.type).toBe("scam_name");
    expect(ev._hunt_source).toBe("pumpfun");
  });
});

// ─── Hunter fetchDS rate-limit backoff ────────────────────────────────────

describe("HN1: hunter fetchDS rate-limit handling", () => {
  it("returns null after max retries on 429 without throwing", async () => {
    // Mock fetch to always return 429
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    vi.stubGlobal("fetch", mockFetch);

    vi.resetModules();
    // Import a minimal version — just test the behavior indirectly via
    // huntDexScreenerSearch returning empty on 429
    const { runHunterExpedition } = await import("../tools/hunter-agent.js");
    // runHunterExpedition catches all errors via Promise.allSettled, so no throw
    const result = await runHunterExpedition({ strategy: { narratives: [] } });
    expect(Array.isArray(result)).toBe(true);
    // All fetches returned 429 → empty results
    expect(result.length).toBe(0);

    vi.unstubAllGlobals();
  });
});

// ─── Learning agent open-trade persistence (sync atomicWriteJson) ──────────

describe("LA2: buy/exit listeners survive _saveOpenTrades", () => {
  // Regression: _saveOpenTrades called .catch() on sync atomicWriteJson's
  // undefined return — a TypeError that killed every llm_buy/llm_exit_executed
  // listener before any learning logic ran (and surfaced as unhandled
  // rejections in the live management cycle).
  it("llm_buy → llm_exit_executed round-trip produces no unhandled rejection", async () => {
    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const { agentBus } = await import("../agents/agent-bus.js");
      const { initLearningAgent } = await import("../agents/learning-agent.js");
      initLearningAgent();

      agentBus.emit("management:llm_buy", {
        mint: "LA2TestMint1111111111111111111111111111111",
        symbol: "LA2T",
        _hunt_source: "pumpfun",
      });
      agentBus.emit("management:llm_exit_executed", {
        mint: "LA2TestMint1111111111111111111111111111111",
        symbol: "LA2T",
        reason: "takeProfit",
        pnl_pct: 12,
      });
      // Listeners are async — give them a tick to settle (or reject).
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections.map((e) => String(e?.message || e))).toEqual([]);
  });
});
