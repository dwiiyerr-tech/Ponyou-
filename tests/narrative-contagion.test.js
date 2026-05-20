import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuggedNarratives,
  filterNarrativeContagion,
  recordRuggedNarrativesForExit,
} from "../narrative-contagion.js";

describe("narrative contagion filter", () => {
  beforeEach(() => {
    clearRuggedNarratives();
  });

  it("skips candidates whose narrative had at least two recent rugs", () => {
    const now = Date.parse("2026-05-20T00:00:00.000Z");
    recordRuggedNarrativesForExit({
      reason: "rug_monitor_dev_sell",
      token: { narrative_tags: ["AI"] },
      nowMs: now - 30 * 60_000,
    });
    recordRuggedNarrativesForExit({
      reason: "liquidity_removal",
      token: { narrative: "AI" },
      nowMs: now - 5 * 60_000,
    });

    const logFn = vi.fn();
    const filtered = filterNarrativeContagion([
      { symbol: "AIX", narrative_tags: ["AI"] },
      { symbol: "CLEAN", narrative_tags: ["GAMING"] },
    ], { nowMs: now, logFn });

    expect(filtered.map(t => t.symbol)).toEqual(["CLEAN"]);
    expect(logFn).toHaveBeenCalledWith("narrative_contagion", 'skipping AIX — narrative "AI" had 2 rugs');
  });

  it("allows clean narratives", () => {
    const now = Date.parse("2026-05-20T00:00:00.000Z");
    recordRuggedNarrativesForExit({
      reason: "rug_monitor_dev_sell",
      token: { narrative_tags: ["AI"] },
      nowMs: now - 5 * 60_000,
    });

    const filtered = filterNarrativeContagion([
      { symbol: "CLEAN", narrative_tags: ["GAMING"] },
    ], { nowMs: now, logFn: vi.fn() });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].symbol).toBe("CLEAN");
  });
});
