import { describe, it, expect, vi } from "vitest";
import {
  StrategyRuntimeSelector,
  setRuntimeSelector,
  getRuntimeSelector,
  evolvedRulesToOverrides,
  evolvedRulesToRoiPatch,
} from "../strategy-runtime-selector.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeRegistry(active = []) {
  // active is an array of "active" strategies — getBestActive picks first
  // one matching regime (or any if regime null).
  return {
    getBestActive(regime) {
      const matches = active.filter(s => !regime || !s.regime || s.regime === regime);
      return matches[0] || null;
    },
  };
}

function activeStrategy(overrides = {}) {
  return {
    id: "evo-001",
    name: "evolved-hybrid",
    status: "active",
    regime: "HOT",
    rules: { signal: "fundamental-strong", tpPct: 70, stopLossPct: 12 },
    scores: { live: 0.90, paper: 0.88, backtest: 0.85 },
    evidence: { live: { trades: 25 } },
    ...overrides,
  };
}

describe("evolvedRulesToOverrides", () => {
  it("maps stopLossPct → negative stoploss decimal", () => {
    const o = evolvedRulesToOverrides({ stopLossPct: 18 });
    expect(o).toEqual({ stoploss: -0.18 });
  });

  it("preserves negative input as magnitude", () => {
    const o = evolvedRulesToOverrides({ stopLossPct: -12 });
    expect(o.stoploss).toBe(-0.12);
  });

  it("enables trailing when offset/distance set", () => {
    const o = evolvedRulesToOverrides({ trailingOffset: 0.25, trailingDistance: 0.08 });
    expect(o.trailing_enabled).toBe(true);
    expect(o.trailing_offset).toBe(0.25);
    expect(o.trailing_distance).toBe(0.08);
  });

  it("enables partial TP when at/sell set", () => {
    const o = evolvedRulesToOverrides({ partialTpAt: 35, partialTpSell: 40 });
    expect(o.partial_tp_enabled).toBe(true);
    expect(o.partial_tp_at).toBe(35);
    expect(o.partial_tp_sell).toBe(40);
  });

  it("returns null when rules don't carry any runtime-relevant field", () => {
    expect(evolvedRulesToOverrides({ signal: "x", entryRsi: 30 })).toBeNull();
    expect(evolvedRulesToOverrides({})).toBeNull();
    expect(evolvedRulesToOverrides(null)).toBeNull();
  });
});

describe("evolvedRulesToRoiPatch", () => {
  it("maps tpPct → first ROI bucket", () => {
    const patch = evolvedRulesToRoiPatch({ tpPct: 60 });
    expect(patch).toEqual({ "0": 0.6 });
  });

  it("accepts alias takeProfitPct", () => {
    expect(evolvedRulesToRoiPatch({ takeProfitPct: 45 })).toEqual({ "0": 0.45 });
  });

  it("returns null when no TP info", () => {
    expect(evolvedRulesToRoiPatch({ stopLossPct: 10 })).toBeNull();
    expect(evolvedRulesToRoiPatch({})).toBeNull();
  });
});

describe("StrategyRuntimeSelector", () => {
  it("returns null when disabled", () => {
    const sel = new StrategyRuntimeSelector({
      registry: makeRegistry([activeStrategy()]),
      config: { enabled: false, mode: "live" },
      logger: silentLogger,
    });
    expect(sel.effectiveOverrides("HOT")).toBeNull();
  });

  it("returns null when no evolved match for regime", () => {
    const sel = new StrategyRuntimeSelector({
      registry: makeRegistry([activeStrategy({ regime: "HOT" })]),
      config: { enabled: true, mode: "live" },
      logger: silentLogger,
    });
    expect(sel.effectiveOverrides("DEAD")).toBeNull();
  });

  it("returns null when live score below floor", () => {
    const sel = new StrategyRuntimeSelector({
      registry: makeRegistry([activeStrategy({ scores: { live: 0.70 } })]),
      config: { enabled: true, mode: "live", minLiveScoreForOverride: 0.85 },
      logger: silentLogger,
    });
    expect(sel.effectiveOverrides("HOT")).toBeNull();
  });

  it("returns null when live trade count below floor", () => {
    const sel = new StrategyRuntimeSelector({
      registry: makeRegistry([activeStrategy({ evidence: { live: { trades: 5 } } })]),
      config: { enabled: true, mode: "live", minLiveTradesForOverride: 20 },
      logger: silentLogger,
    });
    expect(sel.effectiveOverrides("HOT")).toBeNull();
  });

  it("returns null when strategy is not status=active", () => {
    const sel = new StrategyRuntimeSelector({
      registry: makeRegistry([activeStrategy({ status: "candidate" })]),
      config: { enabled: true, mode: "live" },
      logger: silentLogger,
    });
    expect(sel.effectiveOverrides("HOT")).toBeNull();
  });

  it("shadow mode picks evolved but returns no actual overrides", () => {
    const logs = [];
    const sel = new StrategyRuntimeSelector({
      registry: makeRegistry([activeStrategy()]),
      config: { enabled: true, mode: "shadow", minLiveScoreForOverride: 0.85, minLiveTradesForOverride: 20 },
      logger: { info: (m) => logs.push(String(m)), warn: () => {}, error: () => {} },
    });
    const result = sel.effectiveOverrides("HOT");
    expect(result).not.toBeNull();
    expect(result.source).toBe("shadow");
    expect(result.overrides).toBeNull();
    expect(result.roiPatch).toBeNull();
    expect(result.evolvedId).toBe("evo-001");
    expect(logs.some(l => /strategy_shadow/.test(l))).toBe(true);
  });

  it("live mode returns overrides + roiPatch", () => {
    const sel = new StrategyRuntimeSelector({
      registry: makeRegistry([activeStrategy()]),
      config: { enabled: true, mode: "live", minLiveScoreForOverride: 0.85, minLiveTradesForOverride: 20 },
      logger: silentLogger,
    });
    const result = sel.effectiveOverrides("HOT");
    expect(result.source).toBe("evolved");
    expect(result.overrides).toEqual({ stoploss: -0.12 });
    expect(result.roiPatch).toEqual({ "0": 0.7 });
  });

  it("caches result within TTL window", () => {
    const getBestActiveSpy = vi.fn(() => activeStrategy());
    const sel = new StrategyRuntimeSelector({
      registry: { getBestActive: getBestActiveSpy },
      config: { enabled: true, mode: "live", cacheTtlMs: 60_000, minLiveScoreForOverride: 0.85, minLiveTradesForOverride: 20 },
      logger: silentLogger,
    });
    sel.effectiveOverrides("HOT");
    sel.effectiveOverrides("HOT");
    sel.effectiveOverrides("HOT");
    expect(getBestActiveSpy).toHaveBeenCalledTimes(1);
  });

  it("survives registry that throws", () => {
    const sel = new StrategyRuntimeSelector({
      registry: { getBestActive: () => { throw new Error("registry corrupt"); } },
      config: { enabled: true, mode: "live" },
      logger: silentLogger,
    });
    expect(sel.effectiveOverrides("HOT")).toBeNull();
  });

  it("snapshot reports config + cached entries", () => {
    const sel = new StrategyRuntimeSelector({
      registry: makeRegistry([activeStrategy()]),
      config: { enabled: true, mode: "shadow" },
      logger: silentLogger,
    });
    sel.effectiveOverrides("HOT");
    const snap = sel.snapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.mode).toBe("shadow");
    expect(snap.cachedRegimes).toHaveLength(1);
    expect(snap.cachedRegimes[0].evolvedId).toBe("evo-001");
  });

  it("invalidateCache clears stored entries", () => {
    const getBestActiveSpy = vi.fn(() => activeStrategy());
    const sel = new StrategyRuntimeSelector({
      registry: { getBestActive: getBestActiveSpy },
      config: { enabled: true, mode: "live" },
      logger: silentLogger,
    });
    sel.effectiveOverrides("HOT");
    sel.invalidateCache();
    sel.effectiveOverrides("HOT");
    expect(getBestActiveSpy).toHaveBeenCalledTimes(2);
  });
});

describe("singleton getRuntimeSelector / setRuntimeSelector", () => {
  it("setRuntimeSelector(null) clears the singleton", () => {
    setRuntimeSelector(new StrategyRuntimeSelector({
      registry: makeRegistry([]),
      config: { enabled: true },
    }));
    expect(getRuntimeSelector()).not.toBeNull();
    setRuntimeSelector(null);
    expect(getRuntimeSelector()).toBeNull();
  });

  it("getStrategy consults selector when regime is provided", async () => {
    const { getStrategy, setActiveStrategy } = await import("../strategies.js");
    setActiveStrategy("scalping");

    // Live evolved strategy with WR 90% and 25 trades.
    const evolved = activeStrategy({
      regime: "HOT",
      rules: { signal: "x", tpPct: 55, stopLossPct: 10 },
      scores: { live: 0.90 },
      evidence: { live: { trades: 25 } },
    });
    const selector = new StrategyRuntimeSelector({
      registry: { getBestActive: () => evolved },
      config: { enabled: true, mode: "live", minLiveScoreForOverride: 0.85, minLiveTradesForOverride: 20 },
      logger: silentLogger,
    });
    setRuntimeSelector(selector);

    const withEvolved = getStrategy("scalping", { regime: "HOT" });
    expect(withEvolved.stoploss).toBe(-0.10);                     // evolved override applied
    expect(withEvolved.minimal_roi["0"]).toBe(0.55);              // ROI patch applied
    expect(withEvolved._runtime_source).toBe("evolved");
    expect(withEvolved._evolved_id).toBe("evo-001");

    // Without regime → no selector consultation → preset values.
    setRuntimeSelector(null);  // belt and suspenders
    const withoutEvolved = getStrategy("scalping");
    expect(withoutEvolved._runtime_source).toBe("preset");
    expect(withoutEvolved._evolved_id).toBeNull();
  });

  it("getStrategy patches regime-specific ROI table too (not just minimal_roi)", async () => {
    const { getStrategy } = await import("../strategies.js");
    const evolved = activeStrategy({
      regime: "HOT",
      rules: { tpPct: 80, stopLossPct: 8 },
      scores: { live: 0.95 },
      evidence: { live: { trades: 30 } },
    });
    const selector = new StrategyRuntimeSelector({
      registry: { getBestActive: () => evolved },
      config: { enabled: true, mode: "live", minLiveScoreForOverride: 0.85, minLiveTradesForOverride: 20 },
      logger: silentLogger,
    });
    setRuntimeSelector(selector);

    const strat = getStrategy("scalping", { regime: "HOT" });
    // Patch should land on BOTH minimal_roi[0] AND roi_presets.HOT[0]
    expect(strat.minimal_roi["0"]).toBe(0.80);
    expect(strat.roi_presets.HOT["0"]).toBe(0.80);
    // Other regimes untouched.
    expect(strat.roi_presets.DEAD["0"]).toBe(0.15);

    setRuntimeSelector(null);
  });

  it("getStrategy in shadow mode does NOT apply evolved overrides", async () => {
    const { getStrategy } = await import("../strategies.js");
    const evolved = activeStrategy({
      regime: "HOT",
      rules: { stopLossPct: 5 },  // would be very tight if applied
      scores: { live: 0.95 },
      evidence: { live: { trades: 30 } },
    });
    const selector = new StrategyRuntimeSelector({
      registry: { getBestActive: () => evolved },
      config: { enabled: true, mode: "shadow", minLiveScoreForOverride: 0.85, minLiveTradesForOverride: 20 },
      logger: silentLogger,
    });
    setRuntimeSelector(selector);

    const result = getStrategy("scalping", { regime: "HOT" });
    expect(result._runtime_source).toBe("shadow");
    expect(result._evolved_id).toBe("evo-001");
    expect(result.stoploss).toBe(-0.15);  // PRESET scalping default, unchanged

    setRuntimeSelector(null);
  });
});
