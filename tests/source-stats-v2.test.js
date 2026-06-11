/**
 * Source-stats v2 (exp #11): real-trade counters and shadow/no-buy observation
 * counters are separated; rug/win rates blend shadow with
 * config.learning.shadowObservationWeight. Background: shadow events
 * outnumbered real trades ~500:1 and pinned rug_rate at 1.0 for the generic
 * "hunters" source, choking hunter thresholds on poisoned data.
 *
 * PONYOU_HUNTER_PERF_FILE must point at a tmp file BEFORE the module is
 * imported — never the live hunter-performance.json.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TMP = path.join(os.tmpdir(), `hunter-perf-test-${process.pid}.json`);
process.env.PONYOU_HUNTER_PERF_FILE = TMP;

const { bumpSource } = await import("../agents/learning-agent.js");
const { config } = await import("../config.js");

function readPerf() { return JSON.parse(fs.readFileSync(TMP, "utf8")); }

beforeEach(() => { try { fs.unlinkSync(TMP); } catch { /* fresh */ } });

describe("bumpSource v2 — separated counters", () => {
  it("trade outcomes land in real counters only", () => {
    bumpSource("srcA", "win");
    bumpSource("srcA", "rug");
    const s = readPerf().sources.srcA;
    expect(s.won).toBe(1);
    expect(s.rugged).toBe(1);
    expect(s.shadow_won).toBe(0);
    expect(s.shadow_rugged).toBe(0);
  });

  it("shadow outcomes land in shadow counters only", () => {
    bumpSource("srcB", "rug", "shadow");
    bumpSource("srcB", "win", "shadow");
    const s = readPerf().sources.srcB;
    expect(s.rugged).toBe(0);
    expect(s.won).toBe(0);
    expect(s.shadow_rugged).toBe(1);
    expect(s.shadow_won).toBe(1);
    expect(s.found).toBe(0);
    expect(s.shadow_found).toBe(2);
  });

  it("blends rates with the configured shadow weight", () => {
    const w = config.learning?.shadowObservationWeight ?? 1.0;
    // 1 real win + 1 shadow rug
    bumpSource("srcC", "win");
    bumpSource("srcC", "rug", "shadow");
    const s = readPerf().sources.srcC;
    const effective = 1 + w * 1;
    expect(s.effective_closed).toBeCloseTo(effective, 2);
    expect(s.rug_rate).toBeCloseTo((w * 1) / effective, 3);
    expect(s.win_rate).toBeCloseTo(1 / effective, 3);
  });

  it("a shadow flood cannot pin rug_rate at 1.0 when weight < 1", () => {
    const w = config.learning?.shadowObservationWeight ?? 1.0;
    // Reproduce the poisoning shape: many shadow rugs, two real wins.
    for (let i = 0; i < 100; i++) bumpSource("srcD", "rug", "shadow");
    bumpSource("srcD", "win");
    bumpSource("srcD", "win");
    const s = readPerf().sources.srcD;
    const expected = (w * 100) / (2 + w * 100);
    expect(s.rug_rate).toBeCloseTo(expected, 3);
    if (w < 1) expect(s.rug_rate).toBeLessThan(1.0);
    // Legacy v1 would have reported 100/102 = 0.98 regardless of weight.
  });

  it("shadow survivals enter the denominator and pull rug_rate off 1.0", () => {
    const w = config.learning?.shadowObservationWeight ?? 1.0;
    // Realistic shadow mix (live 2026-06-11: 8 survived, 2 mooned, 1 rugged)
    for (let i = 0; i < 8; i++) bumpSource("srcE", "neutral", "shadow");
    bumpSource("srcE", "win", "shadow");
    bumpSource("srcE", "win", "shadow");
    bumpSource("srcE", "rug", "shadow");
    const s = readPerf().sources.srcE;
    expect(s.shadow_survived).toBe(8);
    // rug_rate = w*1 / (w*11) = 1/11 regardless of weight — honest base rate
    expect(s.rug_rate).toBeCloseTo(1 / 11, 2);
    expect(s.rug_rate).toBeLessThan(0.2);
  });

  it("a rug-only shadow stream without survivals still reads 1.0 (no data, no mercy)", () => {
    bumpSource("srcF", "rug", "shadow");
    const s = readPerf().sources.srcF;
    expect(s.rug_rate).toBe(1.0);
    // ...but effective_closed stays tiny, below the 5-sample threshold gate
    expect(s.effective_closed).toBeLessThan(5);
  });

  it("migrates v1 entries (no shadow fields) in place", () => {
    fs.writeFileSync(TMP, JSON.stringify({
      sources: { legacy: { found: 3, won: 1, lost: 1, rugged: 1, rug_rate: 0.333, win_rate: 0.333 } },
      last_updated: null,
    }));
    bumpSource("legacy", "rug", "shadow");
    const s = readPerf().sources.legacy;
    expect(s.shadow_rugged).toBe(1);
    expect(s.won).toBe(1); // real counters untouched
    expect(typeof s.effective_closed).toBe("number");
  });
});
