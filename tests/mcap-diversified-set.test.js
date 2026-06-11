// exp #13 — mcap-band diversified hunting. Two guarantees:
// 1. the diversified active set covers every mcap band from 3K to 50M with
//    no gap, so no tier is structurally unhuntable;
// 2. a primary switch (LLM switch_strategy tool) no longer collapses the
//    multi-strategy set when preserve mode is on.
import fs from "fs";
import { describe, it, expect, beforeEach } from "vitest";
import {
  getStrategy,
  getActiveStrategyIds,
  setActiveStrategies,
  switchPrimaryPreservingSet,
} from "../strategies.js";

const ACTIVE_FILE = process.env.PONYOU_ACTIVE_STRATEGY_FILE;
const DIVERSIFIED_SET = ["scalping", "degen", "dip_buy", "smart_money", "day_phase_trading"];

beforeEach(() => {
  if (ACTIVE_FILE && fs.existsSync(ACTIVE_FILE)) fs.unlinkSync(ACTIVE_FILE);
});

describe("mcap-band coverage of the diversified set", () => {
  it("every band from 3K to 50M is huntable by at least one strategy in the set", () => {
    const bounds = DIVERSIFIED_SET.map((id) => {
      const s = getStrategy(id);
      const f = s.filters || {};
      return { id, min: f.min_mcap_usd, max: f.max_mcap_usd };
    });
    for (const b of bounds) {
      expect(b.min, `${b.id} min_mcap_usd`).toBeGreaterThan(0);
      expect(b.max, `${b.id} max_mcap_usd`).toBeGreaterThan(b.min);
    }
    // Sample mcaps across the whole range — each must match ≥1 strategy.
    const samples = [3_500, 8_000, 50_000, 150_000, 300_000, 800_000, 2_000_000, 25_000_000, 49_000_000];
    for (const mcap of samples) {
      const matches = bounds.filter((b) => mcap >= b.min && mcap <= b.max);
      expect(matches.length, `mcap $${mcap} tidak ter-cover band manapun`).toBeGreaterThan(0);
    }
  });
});

describe("switchPrimaryPreservingSet", () => {
  it("preserve=true moves the primary and keeps the rest of the set", () => {
    setActiveStrategies(DIVERSIFIED_SET);
    const ids = switchPrimaryPreservingSet("smart_money", { preserve: true });
    expect(ids[0]).toBe("smart_money");
    expect(new Set(ids)).toEqual(new Set(DIVERSIFIED_SET));
    expect(new Set(getActiveStrategyIds())).toEqual(new Set(DIVERSIFIED_SET));
  });

  it("preserve=false keeps legacy collapse behavior", () => {
    setActiveStrategies(["scalping", "degen"]);
    const ids = switchPrimaryPreservingSet("smart_money", { preserve: false });
    expect(ids).toEqual(["smart_money"]);
    expect(getActiveStrategyIds()).toEqual(["smart_money"]);
  });

  it("rejects unknown strategy ids", () => {
    expect(() => switchPrimaryPreservingSet("nope", { preserve: true })).toThrow(/Unknown strategy/);
  });
});
