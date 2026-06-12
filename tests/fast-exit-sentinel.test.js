/**
 * Fast-exit sentinel (exp #24) — wakes the management cycle early on a stop
 * breach, never sells on its own. Kontrak yang dikunci: no-positions = no
 * fetch, SL strategi per-posisi, hard-drop floor, debounce trigger, dan
 * no-data = no-guess.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sentinelTick, _resetSentinelForTests } from "../tools/fast-exit-sentinel.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../metrics.js", () => ({ recordCounter: vi.fn() }));

afterEach(() => _resetSentinelForTests());

const pos = (key, entry, strategy = "scalping") => ({
  position_key: key, closed: false, strategy_used: strategy,
  pool_name: key.slice(0, 4), signal_snapshot: { entry_price: entry },
});

function deps(over = {}) {
  return {
    getOpenPositions: () => [pos("MintA::w", 1.0)],
    fetchPrices: vi.fn(async () => new Map([["MintA", 0.85]])), // -15%
    getStrategyById: () => ({ stoploss: -0.12 }),
    triggerCycle: vi.fn(async () => {}),
    config: {},
    now: 1_800_000_000_000,
    ...over,
  };
}

describe("sentinelTick", () => {
  it("does nothing (no price fetch) when there are no open positions", async () => {
    const d = deps({ getOpenPositions: () => [] });
    const r = await sentinelTick(d);
    expect(r.checked).toBe(0);
    expect(d.fetchPrices).not.toHaveBeenCalled();
  });

  it("breaches on the position's strategy SL and wakes the cycle once", async () => {
    const d = deps();
    const r = await sentinelTick(d);
    expect(r.breached).toHaveLength(1);
    expect(r.breached[0].reason).toBe("strategy_sl");
    expect(r.triggered).toBe(true);
    expect(d.triggerCycle).toHaveBeenCalledTimes(1);
  });

  it("debounces: a second breach within 60s does not re-trigger", async () => {
    const d = deps();
    await sentinelTick(d);
    const r2 = await sentinelTick({ ...d, now: d.now + 30_000 });
    expect(r2.breached).toHaveLength(1);
    expect(r2.triggered).toBe(false);
    expect(d.triggerCycle).toHaveBeenCalledTimes(1);
  });

  it("above the stop, nothing fires", async () => {
    const d = deps({ fetchPrices: async () => new Map([["MintA", 0.95]]) }); // -5%
    const r = await sentinelTick(d);
    expect(r.breached).toHaveLength(0);
    expect(d.triggerCycle).not.toHaveBeenCalled();
  });

  it("hard-drop floor fires even when the strategy SL is looser", async () => {
    const d = deps({
      fetchPrices: async () => new Map([["MintA", 0.6]]),       // -40%
      getStrategyById: () => ({ stoploss: -0.5 }),               // SL -50 (longgar)
    });
    const r = await sentinelTick(d);
    expect(r.breached[0].reason).toBe("hard_drop");
    expect(r.triggered).toBe(true);
  });

  it("never guesses without data: missing price or entry = skip", async () => {
    const d = deps({
      getOpenPositions: () => [pos("MintA::w", 0), pos("MintB::w", 1.0)],
      fetchPrices: async () => new Map(), // tidak ada harga sama sekali
    });
    const r = await sentinelTick(d);
    expect(r.checked).toBe(2);
    expect(r.breached).toHaveLength(0);
  });

  it("config.triggerPnlPct overrides the strategy SL", async () => {
    const d = deps({
      fetchPrices: async () => new Map([["MintA", 0.93]]),       // -7%
      config: { triggerPnlPct: -5 },
    });
    const r = await sentinelTick(d);
    expect(r.breached).toHaveLength(1);
    expect(r.breached[0].threshold).toBe(-5);
  });
});
