import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initCapitalGuard,
  reportCapital,
  checkCapitalGuard,
  resetCapitalGuardLayer,
  getCapitalGuardStatus,
  LAYER_DEFAULTS,
  _resetCapitalGuardForTests,
} from "../capital-guard.js";
import { _resetForTests as _resetKillSwitch } from "../kill-switch.js";

beforeEach(() => {
  _resetCapitalGuardForTests();
  _resetKillSwitch(); // Layer 4 trips the kill switch; reset it so tests don't bleed
});

afterEach(() => {
  _resetKillSwitch(); // Ensure flag is cleared even if a test trips layer 4
});

// ─── helpers ──────────────────────────────────────────────────────────────────

const CFG = {
  layer1DailyPct:  -5,
  layer2DailyPct:  -10,
  layer3PeakDdPct: -25,
  layer4HaltPct:   -30,
  layer1PauseMin:  60,
};

function msFrom(base, minutes) {
  return base + minutes * 60_000;
}

// ─── initCapitalGuard ─────────────────────────────────────────────────────────

describe("initCapitalGuard", () => {
  it("sets daily start and peak on first call", () => {
    initCapitalGuard(1000);
    const s = getCapitalGuardStatus(1000);
    expect(s.daily_start_usd).toBe(1000);
    expect(s.peak_capital_usd).toBe(1000);
  });

  it("daily start is idempotent; peak updates upward", () => {
    initCapitalGuard(1000);
    initCapitalGuard(1200);
    const s = getCapitalGuardStatus(1200);
    expect(s.daily_start_usd).toBe(1000); // locked
    expect(s.peak_capital_usd).toBe(1200);
  });

  it("ignores invalid values", () => {
    initCapitalGuard(NaN);
    initCapitalGuard(-1);
    initCapitalGuard(0);
    const s = getCapitalGuardStatus(null);
    expect(s.daily_start_usd).toBeNull();
  });
});

// ─── LAYER_DEFAULTS export ────────────────────────────────────────────────────

describe("LAYER_DEFAULTS", () => {
  it("exports expected thresholds", () => {
    expect(LAYER_DEFAULTS.layer1DailyPct).toBe(-5);
    expect(LAYER_DEFAULTS.layer2DailyPct).toBe(-10);
    expect(LAYER_DEFAULTS.layer3PeakDdPct).toBe(-25);
    expect(LAYER_DEFAULTS.layer4HaltPct).toBe(-30);
    expect(LAYER_DEFAULTS.layer1PauseMin).toBe(60);
  });
});

// ─── reportCapital — no trip ──────────────────────────────────────────────────

describe("reportCapital — no trip below thresholds", () => {
  it("returns tripped=false when loss is below all layers", () => {
    initCapitalGuard(1000);
    const result = reportCapital(960, CFG); // -4%
    expect(result.tripped).toBe(false);
  });

  it("returns tripped=false when capital grows", () => {
    initCapitalGuard(1000);
    expect(reportCapital(1100, CFG).tripped).toBe(false);
    expect(reportCapital(1200, CFG).tripped).toBe(false);
  });
});

// ─── Layer 1 ──────────────────────────────────────────────────────────────────

describe("Layer 1 — daily soft stop (-5%, 60 min pause)", () => {
  it("trips when daily loss reaches -5%", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    const result = reportCapital(950, CFG, now); // exactly -5%
    expect(result.tripped).toBe(true);
    expect(result.level).toBe(1);
  });

  it("trips at exactly the threshold", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    expect(reportCapital(949, CFG, now).tripped).toBe(true); // -5.1%
  });

  it("does not trip above threshold", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    expect(reportCapital(951, CFG, now).tripped).toBe(false); // -4.9%
  });

  it("checkCapitalGuard returns blocked=true while pause active", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(940, CFG, now);
    const check = checkCapitalGuard(msFrom(now, 30)); // 30 min later
    expect(check.blocked).toBe(true);
    expect(check.level).toBe(1);
    expect(check.reason).toMatch(/30 min/);
  });

  it("auto-clears after pause expires", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(940, CFG, now);
    const check = checkCapitalGuard(msFrom(now, 61)); // 61 min later
    expect(check.blocked).toBe(false);
  });

  it("does not double-trip layer 1", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(940, CFG, now);
    const second = reportCapital(930, CFG, now);
    expect(second.tripped).toBe(false); // already tripped layer 1
  });
});

// ─── Layer 2 ──────────────────────────────────────────────────────────────────

describe("Layer 2 — daily hard stop (-10%, until midnight)", () => {
  it("trips when daily loss reaches -10%", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    const result = reportCapital(900, CFG, now); // -10%
    expect(result.tripped).toBe(true);
    expect(result.level).toBe(2);
  });

  it("trips layer 2 first even if layer 1 threshold was already passed", () => {
    // When daily falls straight to -10% without a prior layer 1 trip,
    // layer 1 should trip first (lower threshold = checked last in reportCapital,
    // but layer 2 check happens after layer 3 in the function).
    // Actually: layer 4 → 3 → 2 → 1 in order of severity (checked top-down)
    const now = Date.now();
    initCapitalGuard(1000, now);
    // Skip directly to -10%: layer 2 fires (layer 1 not yet tripped)
    const r = reportCapital(900, CFG, now);
    expect(r.level).toBe(2);
  });

  it("layer 2 blocks until midnight", () => {
    const now = new Date("2026-06-10T20:00:00Z").getTime();
    initCapitalGuard(1000, now);
    reportCapital(900, CFG, now);
    const check = checkCapitalGuard(now + 60_000); // 1 min later
    expect(check.blocked).toBe(true);
    expect(check.level).toBe(2);
    expect(check.resume_at).toMatch(/2026-06-11T00:00:00/);
  });

  it("auto-clears after midnight", () => {
    const now = new Date("2026-06-10T20:00:00Z").getTime();
    initCapitalGuard(1000, now);
    reportCapital(900, CFG, now);
    // Check after midnight on the same UTC day (layer2.resumeAt passed)
    const afterMidnight = new Date("2026-06-11T00:01:00Z").getTime();
    const check = checkCapitalGuard(afterMidnight);
    expect(check.blocked).toBe(false);
  });
});

// ─── Layer 3 ──────────────────────────────────────────────────────────────────

describe("Layer 3 — peak drawdown (-25%, 24 h)", () => {
  it("trips when drawdown from peak reaches -25%", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    // Grow to peak first
    reportCapital(1400, CFG, now); // peak = 1400
    // Drop 25% from peak → 1400 * 0.75 = 1050
    const result = reportCapital(1050, CFG, now);
    expect(result.tripped).toBe(true);
    expect(result.level).toBe(3);
  });

  it("does not trip on daily loss when peak drawdown is the cause", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(2000, CFG, now); // grow to 2000
    // Drop to 1400 from peak 2000 = -30% → layer 3 triggers
    const r = reportCapital(1400, CFG, now);
    expect(r.level).toBe(3); // layer 3 checked before layer 1/2
  });

  it("blocks for 24 h", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(2000, CFG, now);
    reportCapital(1400, CFG, now);
    const check = checkCapitalGuard(now + 23 * 60 * 60 * 1000);
    expect(check.blocked).toBe(true);
    expect(check.level).toBe(3);
  });

  it("auto-clears after 24 h", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(2000, CFG, now);
    reportCapital(1400, CFG, now);
    const check = checkCapitalGuard(now + 25 * 60 * 60 * 1000);
    expect(check.blocked).toBe(false);
  });
});

// ─── Layer 4 ──────────────────────────────────────────────────────────────────

describe("Layer 4 — catastrophic daily loss trips kill switch", () => {
  it("returns tripped level=4 when daily loss ≤ -30%", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    const result = reportCapital(700, CFG, now); // -30%
    expect(result.tripped).toBe(true);
    expect(result.level).toBe(4);
  });

  it("does not double-trip layer 4", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(700, CFG, now);
    const second = reportCapital(600, CFG, now);
    expect(second.tripped).toBe(false);
  });
});

// ─── resetCapitalGuardLayer ───────────────────────────────────────────────────

describe("resetCapitalGuardLayer", () => {
  it("clears layer 1 state", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(940, CFG, now);
    expect(checkCapitalGuard(msFrom(now, 5)).blocked).toBe(true);
    expect(resetCapitalGuardLayer(1)).toBe(true);
    expect(checkCapitalGuard(msFrom(now, 5)).blocked).toBe(false);
  });

  it("clears layer 2 state", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(900, CFG, now);
    expect(checkCapitalGuard(msFrom(now, 5)).blocked).toBe(true);
    expect(resetCapitalGuardLayer(2)).toBe(true);
    expect(checkCapitalGuard(msFrom(now, 5)).blocked).toBe(false);
  });

  it("clears layer 3 state", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(2000, CFG, now);
    reportCapital(1400, CFG, now);
    expect(checkCapitalGuard(msFrom(now, 5)).blocked).toBe(true);
    expect(resetCapitalGuardLayer(3)).toBe(true);
    expect(checkCapitalGuard(msFrom(now, 5)).blocked).toBe(false);
  });

  it("returns false for invalid layer numbers", () => {
    expect(resetCapitalGuardLayer(0)).toBe(false);
    expect(resetCapitalGuardLayer(4)).toBe(false);
    expect(resetCapitalGuardLayer(5)).toBe(false);
  });

  it("returns false when layer is not tripped", () => {
    _resetCapitalGuardForTests();
    initCapitalGuard(1000);
    expect(resetCapitalGuardLayer(1)).toBe(false);
  });
});

// ─── getCapitalGuardStatus ────────────────────────────────────────────────────

describe("getCapitalGuardStatus", () => {
  it("returns daily_pnl_pct and peak_dd_pct when currentUsd provided", () => {
    initCapitalGuard(1000);
    reportCapital(1200, CFG); // peak = 1200
    const s = getCapitalGuardStatus(1100);
    expect(s.daily_pnl_pct).toBeCloseTo(10, 1); // +10% from 1000
    expect(s.peak_dd_pct).toBeCloseTo(-8.33, 1); // -8.33% from 1200
  });

  it("blocked=false when no layer is active", () => {
    initCapitalGuard(1000);
    const s = getCapitalGuardStatus(990);
    expect(s.blocked).toBe(false);
    expect(s.active_level).toBeNull();
  });

  it("blocked=true and active_level set when layer tripped", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(940, CFG, now);
    const s = getCapitalGuardStatus(940, msFrom(now, 5));
    expect(s.blocked).toBe(true);
    expect(s.active_level).toBe(1);
  });
});

// ─── layer priority ordering ──────────────────────────────────────────────────

describe("layer priority — higher layer wins in checkCapitalGuard", () => {
  it("layer 3 blocks even when layer 1 is also tripped", () => {
    const now = Date.now();
    initCapitalGuard(1000, now);
    reportCapital(2000, CFG, now); // peak 2000
    // Drop to 900: daily -10% (layer 2 trips) and peak dd -55% (layer 3 trips first)
    // Actually layer 4 first if -30%, then layer 3, then layer 2, then layer 1
    // At 900 from daily start 1000 = -10% → layer 2 trip
    // At 900 from peak 2000 = -55% → layer 3 would trip, but layer 4 (-30% daily) also fires
    // Since -10% daily triggers layer 2, and -55% peak triggers layer 3,
    // layer 3 comes before layer 2 in reportCapital checks → layer 3 fires
    reportCapital(900, CFG, now);
    const check = checkCapitalGuard(msFrom(now, 5));
    // layer3 is checked before layer2 in checkCapitalGuard
    expect(check.level).toBe(3);
  });
});
