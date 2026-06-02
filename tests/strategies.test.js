import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_FILE = path.join(__dirname, "..", "active-strategy.json");
const OVERRIDES_FILE = path.join(__dirname, "..", "strategies-overrides.json");

function cleanFiles() {
  try { fs.unlinkSync(ACTIVE_FILE); } catch (_) {}
  try { fs.unlinkSync(OVERRIDES_FILE); } catch (_) {}
}

beforeEach(() => {
  cleanFiles();
  vi.resetModules();
});

afterEach(() => cleanFiles());

describe("strategies — PRESETS", () => {
  it("has all 6 built-in presets", async () => {
    const { PRESETS } = await import("../strategies.js");
    expect(Object.keys(PRESETS)).toHaveLength(6);
    expect(PRESETS.scalping).toBeDefined();
    expect(PRESETS.sniper).toBeDefined();
    expect(PRESETS.dip_buy).toBeDefined();
    expect(PRESETS.smart_money).toBeDefined();
    expect(PRESETS.degen).toBeDefined();
    expect(PRESETS.day_phase_trading).toBeDefined();
  });

  it("scalping preset has valid filters", async () => {
    const { PRESETS } = await import("../strategies.js");
    const s = PRESETS.scalping;
    expect(s.filters.maxEntryPumpMc).toBeGreaterThan(0);
    expect(s.stoploss).toBeLessThan(0);
    expect(s.use_llm).toBe(true);
    expect(s.trailing_stop.enabled).toBe(true);
  });

  // BUG 1 regression: scalping ran as part of the live multi-strategy set
  // ["degen","scalping","smart_money"] WITHOUT mcap bounds. applyStrategyFilters
  // skips the mcap gate when min/max are not finite, so scalping matched tokens
  // of any size — a $10M token could fail degen/smart_money yet slip through
  // scalping. Bounds must be finite micro-cap values so the gate actually fires.
  it("scalping preset has finite micro-cap bounds (BUG 1)", async () => {
    const { PRESETS } = await import("../strategies.js");
    const s = PRESETS.scalping;
    expect(Number.isFinite(s.filters.min_mcap_usd)).toBe(true);
    expect(Number.isFinite(s.filters.max_mcap_usd)).toBe(true);
    expect(s.filters.min_mcap_usd).toBeGreaterThan(0);
    expect(s.filters.max_mcap_usd).toBeGreaterThan(s.filters.min_mcap_usd);
    // micro-cap scoped: must reject a $10M token via the max gate
    expect(s.filters.max_mcap_usd).toBeLessThan(10_000_000);
    expect(Number.isFinite(s.filters.min_token_fees_sol)).toBe(true);
  });

  // A $10M token must actually be flagged by the real entry-gate evaluator
  // when scalping is the active strategy — proves the max-mcap gate fires
  // instead of being silently skipped on an undefined bound.
  it("scalping flags a $10M token via run4FilterProtocol (BUG 1)", async () => {
    const { setActiveStrategy } = await import("../strategies.js");
    const { run4FilterProtocol } = await import("../strategy.js");
    setActiveStrategy("scalping");
    // mcap above scalping.max_mcap_usd (200k); all other gates kept clean.
    const tokenData = { mint: "BugOneMint", symbol: "BIG", mcap: 10_000_000, volume: 0, global_fees_sol: 5 };
    const result = await run4FilterProtocol(tokenData, { holders: [] }, { level: "low" });
    const flagStr = JSON.stringify(result.flags);
    expect(flagStr).toMatch(/MCap above/i);
  });

  it("sniper preset has strict gate filters", async () => {
    const { PRESETS } = await import("../strategies.js");
    const s = PRESETS.sniper;
    expect(s.filters.maxAllowedFlags).toBeLessThanOrEqual(1); // was 0; relaxed to 1 to allow realistic tokens
    expect(s.filters.min_token_fees_sol).toBeLessThanOrEqual(2); // was 10; 1 SOL is realistic
    expect(s.filters.min_mcap_usd).toBeGreaterThan(0);
    expect(s.filters.max_mcap_usd).toBeGreaterThan(s.filters.min_mcap_usd);
  });

  it("dip_buy preset has staged entry enabled", async () => {
    const { PRESETS } = await import("../strategies.js");
    const s = PRESETS.dip_buy;
    expect(s.staged_entry.enabled).toBe(true);
    expect(s.staged_entry.stages).toBe(3);
    expect(s.staged_entry.stage_pct.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it("smart_money preset has partial TP enabled", async () => {
    const { PRESETS } = await import("../strategies.js");
    const s = PRESETS.smart_money;
    expect(s.partial_tp.enabled).toBe(true);
    expect(s.partial_tp.at_pct).toBe(100);
    expect(s.partial_tp.sell_pct).toBe(50);
  });

  it("degen preset has llm disabled", async () => {
    const { PRESETS } = await import("../strategies.js");
    const s = PRESETS.degen;
    expect(s.use_llm).toBe(false);
    expect(s.stoploss).toBe(-0.15);
  });

  it("day_phase_trading has long ROI timeline", async () => {
    const { PRESETS } = await import("../strategies.js");
    const s = PRESETS.day_phase_trading;
    expect(s.filters.min_mcap_usd).toBeGreaterThanOrEqual(500_000); // was 1M; lowered to match social signal mid-cap band
    expect(s.filters.max_ath_distance_pct).toBeLessThanOrEqual(-50);
    expect(s.minimal_roi["4320"]).toBeDefined(); // day 3
  });

  it("every preset has a stoploss < 0", async () => {
    const { PRESETS } = await import("../strategies.js");
    for (const [id, preset] of Object.entries(PRESETS)) {
      expect(preset.stoploss).toBeLessThan(0);
    }
  });

  it("every preset minimal_roi has at least one entry", async () => {
    const { PRESETS } = await import("../strategies.js");
    for (const [id, preset] of Object.entries(PRESETS)) {
      expect(Object.keys(preset.minimal_roi).length).toBeGreaterThan(0);
    }
  });
});

describe("strategies — getActiveStrategyId / getStrategy", () => {
  it("returns scalping when no active file exists", async () => {
    const { getActiveStrategyId } = await import("../strategies.js");
    const id = getActiveStrategyId();
    expect(id).toBe("scalping");
  });

  it("getStrategy returns full preset by id", async () => {
    const { getStrategy } = await import("../strategies.js");
    const degen = getStrategy("degen");
    expect(degen.id).toBe("degen");
    expect(degen.stoploss).toBeLessThan(0);
  });

  it("merges overrides when overrides file exists", async () => {
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ id: "degen" }));
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({ degen: { stoploss: -0.50 } }));
    const { getStrategy } = await import("../strategies.js");
    const active = getStrategy("degen");
    expect(active.id).toBe("degen");
    expect(active.stoploss).toBe(-0.50);
  });
});

describe("strategies — listStrategies", () => {
  it("returns all 6 presets with id and name", async () => {
    const { listStrategies } = await import("../strategies.js");
    const list = listStrategies();
    expect(list).toHaveLength(6);
    for (const s of list) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
    }
  });
});
