// Regression test for S1/T8: getStrategy() must not mutate the global PRESETS
// registry when no user overrides exist. Previously applyOverrides() short-
// circuited and returned the preset reference itself; callers then tagged it
// with _runtime_source / _evolved_id, polluting the global state.

import { describe, it, expect, beforeAll } from "vitest";
import { PRESETS, getStrategy } from "../strategies.js";

describe("getStrategy() does not mutate the global PRESETS registry", () => {
  let scalpingFingerprint;
  let day_phase_fingerprint;

  beforeAll(() => {
    // Deep-copy of the canonical preset to compare against after calls.
    scalpingFingerprint = JSON.parse(JSON.stringify(PRESETS.scalping));
    day_phase_fingerprint = JSON.parse(JSON.stringify(PRESETS.day_phase_trading));
  });

  it("returns a strategy with metadata, but the global preset stays clean", () => {
    const s = getStrategy("scalping", { regime: "HOT" });
    expect(s._runtime_source).toBe("preset");
    expect(PRESETS.scalping._runtime_source).toBeUndefined();
    expect(PRESETS.scalping._evolved_id).toBeUndefined();
  });

  it("multiple calls with different regimes do not leak metadata into PRESETS", () => {
    getStrategy("scalping", { regime: "HOT" });
    getStrategy("scalping", { regime: "DEAD" });
    getStrategy("day_phase_trading", { regime: "COLD" });
    expect(PRESETS.scalping._evolved_id).toBeUndefined();
    expect(PRESETS.scalping._runtime_source).toBeUndefined();
    expect(PRESETS.day_phase_trading._evolved_id).toBeUndefined();
  });

  it("PRESETS deep structure remains identical to its initial fingerprint", () => {
    getStrategy("scalping", { regime: "HOT" });
    getStrategy("day_phase_trading", { regime: "NORMAL" });
    expect(PRESETS.scalping).toEqual(scalpingFingerprint);
    expect(PRESETS.day_phase_trading).toEqual(day_phase_fingerprint);
  });

  it("returned object is a clone (mutations don't propagate to global)", () => {
    const s1 = getStrategy("scalping");
    s1.filters.maxAllowedFlags = 999;
    const s2 = getStrategy("scalping");
    expect(s2.filters.maxAllowedFlags).not.toBe(999);
    expect(PRESETS.scalping.filters.maxAllowedFlags).not.toBe(999);
  });
});

describe("All presets ship regime-tuned roi_presets (S1b)", () => {
  const REGIMES = ["EXTREME", "HOT", "NORMAL", "COLD", "DEAD"];
  for (const id of Object.keys(PRESETS)) {
    it(`${id} has roi_presets for all five regimes`, () => {
      const rp = PRESETS[id].roi_presets;
      expect(rp).toBeDefined();
      for (const r of REGIMES) {
        expect(rp[r], `${id}.roi_presets.${r}`).toBeDefined();
        expect(typeof rp[r]).toBe("object");
        // Each regime must have at least one age threshold.
        expect(Object.keys(rp[r]).length).toBeGreaterThan(0);
      }
    });
  }
});
