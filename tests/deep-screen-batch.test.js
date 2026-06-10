import { describe, it, expect } from "vitest";
import { selectDeepScreenBatch } from "../tools/hunter-agent.js";

const disc = (n) => Array.from({ length: n }, (_, i) => ({ mint: `D${i}` }));
const prey = (n, score = 70) =>
  Array.from({ length: n }, (_, i) => ({ mint: `P${i}`, _hunter_score: score }));

describe("selectDeepScreenBatch", () => {
  // Regression: candidate list is [20 discovery, ...20 prey appended]. The old
  // slice(0, 8) returned discovery only — injected prey (GMGN row-risk,
  // smart-money pings) never reached rug scoring (exp #1 starved for 8 days).
  it("gives appended prey deep-screen slots instead of starving them", () => {
    const batch = selectDeepScreenBatch([...disc(20), ...prey(20)], 8);
    expect(batch).toHaveLength(8);
    expect(batch.filter(t => t.mint.startsWith("P"))).toHaveLength(4);
    expect(batch.filter(t => t.mint.startsWith("D"))).toHaveLength(4);
  });

  it("alternates discovery-first and preserves within-group order", () => {
    const batch = selectDeepScreenBatch([...disc(3), ...prey(3)], 4);
    expect(batch.map(t => t.mint)).toEqual(["D0", "P0", "D1", "P1"]);
  });

  it("fills the whole budget from discovery when there is no prey", () => {
    const batch = selectDeepScreenBatch(disc(12), 8);
    expect(batch.map(t => t.mint)).toEqual(disc(12).slice(0, 8).map(t => t.mint));
  });

  it("fills the whole budget from prey when there is no discovery", () => {
    const batch = selectDeepScreenBatch(prey(12), 8);
    expect(batch).toHaveLength(8);
    expect(batch.every(t => t.mint.startsWith("P"))).toBe(true);
  });

  it("treats sub-50 hunter scores as discovery (WATCH tier carries no slot claim)", () => {
    const weak = prey(4, 25).map(t => ({ ...t, mint: `W${t.mint}` }));
    const batch = selectDeepScreenBatch([...disc(2), ...weak, ...prey(2)], 4);
    expect(batch.filter(t => t.mint.startsWith("P"))).toHaveLength(2);
  });

  it("returns short lists as-is and tolerates bad input", () => {
    const five = [...disc(3), ...prey(2)];
    expect(selectDeepScreenBatch(five, 8)).toEqual(five);
    expect(selectDeepScreenBatch(null, 8)).toEqual([]);
    expect(selectDeepScreenBatch(undefined, 8)).toEqual([]);
  });
});
