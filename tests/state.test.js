import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.PONYOU_STATE_FILE || path.join(__dirname, "..", "state.json");

// Since state.js has a module-level cache, we isolate each describe block
// by resetting the module and removing the state file.

function cleanStateFile() {
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
}

beforeEach(() => cleanStateFile());
afterEach(() => cleanStateFile());

describe("state — getState / load", () => {
  it("returns empty state when no file exists", async () => {
    const { getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const s = getState();
    expect(s.positions).toEqual({});
    expect(s.recentEvents).toEqual([]);
  });

  it("returns cached state on repeated calls", async () => {
    const { getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const a = getState();
    const b = getState();
    expect(a).toBe(b);
  });

  it("handles corrupt state.json gracefully", async () => {
    const { _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    fs.writeFileSync(STATE_FILE, "not json {{{");
    // Reimport to bypass cache
    vi.resetModules();
    const { getState, _resetStateForTests: r2 } = await import("../state.js");
    r2();
    const s = getState();
    expect(s.positions).toEqual({});
  });
});

describe("state — buildPositionKey", () => {
  it("returns position-only key when no wallet", async () => {
    const { buildPositionKey, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    expect(buildPositionKey("mintABC")).toBe("mintABC");
  });

  it("returns composite key with wallet", async () => {
    const { buildPositionKey, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    expect(buildPositionKey("mintABC", "walletX")).toBe("mintABC::walletX");
  });
});

describe("state — trackPosition", () => {
  it("records a new position with required fields", async () => {
    const { trackPosition, getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const key = "So11111111111111111111111111111111111111111";
    await trackPosition({
      position: key,
      pool: "pool123",
      pool_name: "Test Pool",
      amount_sol: 1.5,
      initial_value_usd: 120,
      signal_snapshot: { mint: key, recorded_at: new Date().toISOString() },
      active_lessons: ["lesson1"],
      active_signals: ["signalA"],
      wallet_address: null,
    });
    const pos = getState().positions[key];
    expect(pos).toBeDefined();
    expect(pos.pool_name).toBe("Test Pool");
    expect(pos.amount_sol).toBe(1.5);
    expect(pos.initial_value_usd).toBe(120);
    expect(pos.closed).toBe(false);
    expect(pos.wallet_address).toBeNull();
    expect(pos.chain).toBe("sol"); // default chain
  });

  it("persists chain for EVM positions (exit routing)", async () => {
    const { trackPosition, getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "0xbasetoken";
    await trackPosition({
      position: mint,
      pool: "uniswap",
      pool_name: "Base Token",
      amount_sol: 0.01,
      initial_value_usd: 25,
      chain: "base",
    });
    const pos = getState().positions[mint];
    expect(pos.chain).toBe("base");
  });

  it("defaults chain to sol when not provided", async () => {
    const { trackPosition, getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    await trackPosition({
      position: "So11111111111111111111111111111111111111114",
      pool: "p", amount_sol: 1, initial_value_usd: 100,
    });
    expect(getState().positions["So11111111111111111111111111111111111111114"].chain).toBe("sol");
  });

  it("records multi-wallet positions with composite key", async () => {
    const { trackPosition, getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "So11111111111111111111111111111111111111112";
    await trackPosition({
      position: mint,
      pool: "poolX",
      pool_name: "Wallet Pool",
      amount_sol: 0.5,
      initial_value_usd: 50,
      wallet_address: "walletB",
    });
    const key = "So11111111111111111111111111111111111111112::walletB";
    expect(getState().positions[key]).toBeDefined();
  });

  it("marks pnl_unknown on zero initial_value_usd (ST-6)", async () => {
    const { trackPosition, getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    await trackPosition({
      position: "So11111111111111111111111111111111111111113",
      pool: "p",
      amount_sol: 1,
      initial_value_usd: 0,
    });
    const tracked = getState().positions;
    const key = Object.keys(tracked).find(k => tracked[k].position === "So11111111111111111111111111111111111111113");
    expect(key).toBeDefined();
    // ST-6: previously this fell back to amount_sol (1 SOL ≈ $100) which
    // mixed units (SOL vs USD) and made downstream PnL math off by ~200x.
    // Correct behavior: keep initial_value_usd at 0 and mark pnl_unknown so
    // PnL consumers short-circuit instead of producing misleading numbers.
    expect(tracked[key].initial_value_usd).toBe(0);
    expect(tracked[key].pnl_unknown).toBe(true);
  });

  it("pushes a deploy event", async () => {
    const { trackPosition, getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    await trackPosition({
      position: "So11111111111111111111111111111111111111114",
      pool: "p2",
      amount_sol: 1,
      initial_value_usd: 200,
    });
    const events = getState().recentEvents;
    const deploy = events.find(e => e.action === "deploy");
    expect(deploy).toBeDefined();
  });
});

describe("state — recordClose", () => {
  it("marks a position as closed", async () => {
    const { trackPosition, recordClose, getTrackedPosition, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "So11111111111111111111111111111111111111115";
    await trackPosition({ position: mint, pool: "p", amount_sol: 1, initial_value_usd: 100 });
    const result = recordClose(mint, "manual close");
    await result;
    const pos = getTrackedPosition(mint);
    expect(pos.closed).toBe(true);
    expect(pos.notes.some(n => n.includes("manual close"))).toBe(true);
  });

  it("returns null for unknown position", async () => {
    const { recordClose, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    expect(recordClose("nonexistent", "reason")).toBeNull();
  });
});

describe("state — updatePeakPnl", () => {
  it("stores a higher peak", async () => {
    const { trackPosition, updatePeakPnl, getTrackedPosition, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "So11111111111111111111111111111111111111116";
    await trackPosition({ position: mint, pool: "p", amount_sol: 1, initial_value_usd: 100 });
    await updatePeakPnl(mint, 30);
    const pos = getTrackedPosition(mint);
    expect(pos.peak_pnl_pct).toBe(30);
  });

  it("ignores lower peak", async () => {
    const { trackPosition, updatePeakPnl, getTrackedPosition, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "So11111111111111111111111111111111111111117";
    await trackPosition({ position: mint, pool: "p", amount_sol: 1, initial_value_usd: 100 });
    await updatePeakPnl(mint, 50);
    await updatePeakPnl(mint, 10);
    expect(getTrackedPosition(mint).peak_pnl_pct).toBe(50);
  });
});

describe("state — markPartialTPDone", () => {
  it("marks partial TP executed", async () => {
    const { trackPosition, markPartialTPDone, getTrackedPosition, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "So11111111111111111111111111111111111111118";
    await trackPosition({ position: mint, pool: "p", amount_sol: 1, initial_value_usd: 100 });
    await markPartialTPDone(mint);
    expect(getTrackedPosition(mint).partial_tp_done).toBe(true);
  });
});

describe("state — setPositionInstruction", () => {
  it("sets and clears an instruction", async () => {
    const { trackPosition, setPositionInstruction, getTrackedPosition, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "So11111111111111111111111111111111111111119";
    await trackPosition({ position: mint, pool: "p", amount_sol: 1, initial_value_usd: 100 });
    setPositionInstruction(mint, "hold until 10%");
    expect(getTrackedPosition(mint).instruction).toBe("hold until 10%");
    setPositionInstruction(mint, null);
    expect(getTrackedPosition(mint).instruction).toBeNull();
  });
});

describe("state — cleanStaleTestPositions", () => {
  it("removes test-position markers", async () => {
    const { getState, cleanStaleTestPositions, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const state = getState();
    state.positions["SMOKE_TEST_POS"] = { mint: "SMOKE_TEST_POS", closed: false };
    state.positions["ab::walletX"] = { mint: "ab", closed: false, wallet_address: "walletX" };
    const cleaned = cleanStaleTestPositions();
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(getState().positions["SMOKE_TEST_POS"]).toBeUndefined();
  });
});

describe("state — getStateSummary", () => {
  it("returns empty summary with no positions", async () => {
    const { getStateSummary, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const sum = getStateSummary();
    expect(sum.open_positions).toBe(0);
    expect(sum.closed_positions).toBe(0);
    expect(sum.positions).toEqual([]);
    expect(sum.last_updated).toBeDefined();
    expect(sum.recent_events).toBeDefined();
  });
});

describe("state — briefing dates", () => {
  it("getLastBriefingDate returns null initially", async () => {
    const { getLastBriefingDate, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    expect(getLastBriefingDate()).toBeNull();
  });

  it("setLastBriefingDate sets today", async () => {
    const { setLastBriefingDate, getLastBriefingDate, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    setLastBriefingDate();
    const today = new Date().toISOString().slice(0, 10);
    expect(getLastBriefingDate()).toBe(today);
  });
});

describe("state — syncOpenPositions", () => {
  it("syncOpenPositions is a no-op on empty state", async () => {
    const { syncOpenPositions, getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    getState(); // initialize empty state
    syncOpenPositions([]);
    // No positions to sync — should not throw
    expect(true).toBe(true);
  });

  it("paper_trade=true positions are NOT auto-closed on sync-miss", async () => {
    const { trackPosition, syncOpenPositions, getTrackedPosition, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "PaperMint111111111111111111111111111111111";
    await trackPosition({
      position: mint, pool: "jupiter", pool_name: "PAPER",
      amount_sol: 0.5, initial_value_usd: 50, paper_trade: true,
    });
    // Simulate 10 consecutive sync cycles with mint not in active list
    for (let i = 0; i < 10; i++) syncOpenPositions([]);
    const pos = getTrackedPosition(mint);
    expect(pos).not.toBeNull();
    expect(pos.closed).toBe(false);
    expect(pos.paper_trade).toBe(true);
  });

  it("paper_trade=false positions get sync_misses incremented (not skipped)", async () => {
    const { trackPosition, syncOpenPositions, getTrackedPosition, getState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "LiveMint11111111111111111111111111111111111";
    await trackPosition({
      position: mint, pool: "jupiter", pool_name: "LIVE",
      amount_sol: 0.5, initial_value_usd: 50, paper_trade: false,
    });
    // Backdate deployed_at to bypass SYNC_GRACE_MS (5 min)
    const state = getState();
    const key = Object.keys(state.positions).find(k => k.includes(mint));
    if (key) state.positions[key].deployed_at = new Date(Date.now() - 600_000).toISOString();
    // One sync miss — counter must increment (unlike paper_trade which skips entirely)
    syncOpenPositions([]);
    const pos = getTrackedPosition(mint);
    expect(pos?.paper_trade).toBe(false);
    expect((pos?.sync_misses ?? 0)).toBeGreaterThan(0);
  });

  it("trackPosition stores paper_trade flag correctly", async () => {
    const { trackPosition, getTrackedPosition, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    const mint = "FlagMint1111111111111111111111111111111111";
    await trackPosition({
      position: mint, pool: "jupiter", pool_name: "FLAG",
      amount_sol: 0.1, initial_value_usd: 10, paper_trade: true,
    });
    const pos = getTrackedPosition(mint);
    expect(pos?.paper_trade).toBe(true);
  });
});

describe("state — flushState", () => {
  it("drains the write queue without error", async () => {
    const { flushState, _resetStateForTests } = await import("../state.js");
    _resetStateForTests();
    await expect(flushState()).resolves.toBeUndefined();
  });
});
