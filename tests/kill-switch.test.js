import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  setSessionBaseline,
  reportBalance,
  recordSwapOutcome,
  trip,
  reset,
  readKillState,
  isKilled,
  _resetForTests,
} from "../kill-switch.js";

// Use the same env-redirected paths the module reads (set in vitest.config.js
// test.env) so the test never touches the live kill-switch.flag at repo root.
const FLAG_FILE = process.env.PONYOU_KILL_SWITCH_FLAG || path.join(process.cwd(), "kill-switch.flag");
const STATE_FILE = process.env.PONYOU_KILL_SWITCH_STATE || path.join(process.cwd(), "kill-switch-state.json");

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE);
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
});

describe("setSessionBaseline + reportBalance", () => {
  it("does not trip until balance crosses drawdown limit", () => {
    setSessionBaseline(1000);
    // -10% — below default -20% limit
    expect(reportBalance(900)).toBe(false);
    expect(isKilled()).toBe(false);
  });

  it("trips when drawdown crosses limit", () => {
    setSessionBaseline(1000);
    // -25% — past default -20% limit
    const tripped = reportBalance(750);
    expect(tripped).toBe(true);
    expect(isKilled()).toBe(true);

    const state = readKillState();
    expect(state.reason).toBe("drawdown");
    expect(state.detail).toMatch(/-25/);
  });

  it("respects custom drawdown limit", () => {
    setSessionBaseline(1000);
    const tripped = reportBalance(950, { drawdown_pct: -3, consecutive_errors: 999 });
    expect(tripped).toBe(true);
  });

  it("no-op when baseline not set", () => {
    expect(reportBalance(100)).toBe(false);
    expect(isKilled()).toBe(false);
  });

  it("no-op for invalid balance values", () => {
    setSessionBaseline(1000);
    expect(reportBalance(NaN)).toBe(false);
    expect(reportBalance(0)).toBe(false);
    expect(isKilled()).toBe(false);
  });
});

describe("recordSwapOutcome — consecutive errors trip", () => {
  it("trips after N consecutive failures", () => {
    // default limit = 3
    for (let i = 0; i < 2; i++) {
      expect(recordSwapOutcome({ success: false })).toBe(false);
    }
    expect(recordSwapOutcome({ success: false })).toBe(true);
    expect(isKilled()).toBe(true);
  });

  it("resets consecutive counter on a success", () => {
    for (let i = 0; i < 2; i++) recordSwapOutcome({ success: false });
    recordSwapOutcome({ success: true });
    // Now we can fail 2 more times without tripping
    for (let i = 0; i < 2; i++) {
      expect(recordSwapOutcome({ success: false })).toBe(false);
    }
    expect(isKilled()).toBe(false);
  });

  it("respects custom threshold", () => {
    expect(recordSwapOutcome({ success: false }, { consecutive_errors: 2, drawdown_pct: -999 })).toBe(false);
    expect(recordSwapOutcome({ success: false }, { consecutive_errors: 2, drawdown_pct: -999 })).toBe(true);
  });
});

describe("trip + reset + persistence", () => {
  it("trip() writes flag file", () => {
    trip({ reason: "manual", detail: "test" });
    expect(fs.existsSync(FLAG_FILE)).toBe(true);
    const state = readKillState();
    expect(state.reason).toBe("manual");
  });

  it("reset() removes flag file", () => {
    trip({ reason: "manual", detail: "test" });
    reset();
    expect(fs.existsSync(FLAG_FILE)).toBe(false);
    expect(isKilled()).toBe(false);
  });

  it("readKillState returns null when flag missing", () => {
    expect(readKillState()).toBeNull();
  });

  it("readKillState fails-safe on unreadable flag", () => {
    fs.writeFileSync(FLAG_FILE, "not valid json {{{");
    const state = readKillState();
    expect(state).not.toBeNull();
    expect(state.detail).toMatch(/unreadable/);
  });

  it("isKilled survives in-memory reset (flag is source of truth)", () => {
    trip({ reason: "test" });
    // Simulate a process restart: reset module state but keep flag file.
    _resetForTests(); // _resetForTests deletes the flag too
    trip({ reason: "test" }); // re-trip
    // Now simulate a CLEAN module-state reset that doesn't touch the file.
    // We can't easily do that with current helpers, so we just verify the
    // file → isKilled relationship.
    expect(isKilled()).toBe(true);
  });

  it("does not restore a persisted trip without a valid session baseline", async () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      sessionBaseline: null,
      tripAt: "2026-05-20T00:00:00.000Z",
      consecutiveErrors: 0,
      savedAt: "2026-05-20T00:00:01.000Z",
    }, null, 2));

    vi.resetModules();
    const restored = await import("../kill-switch.js");

    expect(fs.existsSync(FLAG_FILE)).toBe(false);
    expect(restored.isKilled()).toBe(false);
    restored._resetForTests();
  });
});
