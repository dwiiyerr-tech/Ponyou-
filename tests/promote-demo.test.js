/**
 * promote-demo merge policy — gap-fill: demo fills what live lacks, live always
 * wins on conflicts, arrays union, scalar aggregates stay live's. This is the
 * safety contract: promoting paper-trade knowledge must never overwrite or
 * inflate real live data.
 */

import { describe, it, expect } from "vitest";
import { mergeGapFill, PROMOTABLE_FILES } from "../scripts/promote-demo.js";

describe("mergeGapFill", () => {
  it("adds demo-only keys without touching existing live keys", () => {
    const live = { coins: { MintA: { score: 9 } } };
    const demo = { coins: { MintA: { score: 1 }, MintB: { score: 5 } } };
    const { value, added } = mergeGapFill(live, demo);
    expect(value.coins.MintA.score).toBe(9); // live wins — real data preserved
    expect(value.coins.MintB.score).toBe(5); // new coin promoted
    expect(added).toBe(1);
  });

  it("keeps live scalar aggregates (sim never inflates them)", () => {
    const live = { patterns: {}, total_wins: 10, avg_pnl: 4.2 };
    const demo = { patterns: {}, total_wins: 999, avg_pnl: -1 };
    const { value } = mergeGapFill(live, demo);
    expect(value.total_wins).toBe(10);
    expect(value.avg_pnl).toBe(4.2);
  });

  it("unions arrays, appending only demo items live lacks", () => {
    const live = { lessons: ["a", "b"] };
    const demo = { lessons: ["b", "c", "d"] };
    const { value, added } = mergeGapFill(live, demo);
    expect(value.lessons).toEqual(["a", "b", "c", "d"]);
    expect(added).toBe(2);
  });

  it("seeds an empty live branch entirely from demo", () => {
    const live = { regimes: {} };
    const demo = { regimes: { bull: { n: 3 }, bear: { n: 1 } } };
    const { value, added } = mergeGapFill(live, demo);
    expect(value.regimes.bull.n).toBe(3);
    expect(value.regimes.bear.n).toBe(1);
    expect(added).toBe(2);
  });

  it("live wins on type mismatch (no corruption)", () => {
    const live = { x: 5 };
    const demo = { x: { nested: true } };
    const { value, added } = mergeGapFill(live, demo);
    expect(value.x).toBe(5);
    expect(added).toBe(0);
  });

  it("reports zero added when demo contributes nothing new", () => {
    const live = { coins: { A: { s: 1 }, B: { s: 2 } } };
    const demo = { coins: { A: { s: 9 } } };
    const { added } = mergeGapFill(live, demo);
    expect(added).toBe(0);
  });

  it("only promotes knowledge stores (no runtime/safety/position files)", () => {
    const forbidden = [
      "state.json", "kill-switch-state.json", "kill-switch.flag",
      "daily-trade-guard-state.json", "trading-plan.json",
      "execution-quality.json", "trade-attribution.json",
    ];
    for (const f of forbidden) expect(PROMOTABLE_FILES).not.toContain(f);
    // sanity: the core knowledge stores ARE promotable
    expect(PROMOTABLE_FILES).toContain("coin-conviction.json");
    expect(PROMOTABLE_FILES).toContain("rug-patterns-learned.json");
  });
});
