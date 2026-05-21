import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setStateFile,
  isTradingPlanEnabled,
  initTradingPlan,
  recordTrade,
  getTradingPlanStatus,
  resetTradingPlan,
  isSessionComplete,
} from "../trading-plan-30.js";
import { config } from "../config.js";

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-trading-plan-"));
  _setStateFile(path.join(tempDir, "trading-plan-state.json"));
  // ensure trading plan is enabled for most tests
  config.tradingPlan = { enabled: true, targetTrades: 5, resetOnNewSession: false };
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("isTradingPlanEnabled", () => {
  it("returns true when config enabled", () => {
    expect(isTradingPlanEnabled()).toBe(true);
  });

  it("returns false when config disabled", () => {
    config.tradingPlan.enabled = false;
    expect(isTradingPlanEnabled()).toBe(false);
  });
});

describe("initTradingPlan", () => {
  it("creates fresh state when no file exists", () => {
    const status = initTradingPlan();
    expect(status.trades_completed).toBe(0);
    expect(status.target).toBe(5);
    expect(status.session_complete).toBe(false);
    expect(status.enabled).toBe(true);
  });
});

describe("recordTrade", () => {
  it("increments count each call", () => {
    initTradingPlan();
    const r1 = recordTrade({ symbol: "TOKEN", mint: "abc", pnl_pct: 10 });
    expect(r1.count).toBe(1);
    expect(r1.complete).toBe(false);
    const r2 = recordTrade({ symbol: "TOKEN2", mint: "def", pnl_pct: -5 });
    expect(r2.count).toBe(2);
  });

  it("marks complete when target reached", () => {
    initTradingPlan();
    for (let i = 0; i < 5; i++) recordTrade({ symbol: `T${i}`, mint: `m${i}`, pnl_pct: 1 });
    const status = getTradingPlanStatus();
    expect(status.session_complete).toBe(true);
    expect(status.completed_at).not.toBeNull();
  });

  it("returns skipped when disabled", () => {
    config.tradingPlan.enabled = false;
    const result = recordTrade({ symbol: "X", mint: "y", pnl_pct: 5 });
    expect(result.skipped).toBe(true);
  });
});

describe("isSessionComplete", () => {
  it("returns false before target", () => {
    initTradingPlan();
    recordTrade({});
    expect(isSessionComplete()).toBe(false);
  });

  it("returns true at target", () => {
    initTradingPlan();
    for (let i = 0; i < 5; i++) recordTrade({});
    expect(isSessionComplete()).toBe(true);
  });

  it("returns false when disabled even at target", () => {
    config.tradingPlan.enabled = false;
    expect(isSessionComplete()).toBe(false);
  });
});

describe("getTradingPlanStatus", () => {
  it("returns correct remaining and progress_pct", () => {
    initTradingPlan();
    recordTrade({});
    recordTrade({});
    const s = getTradingPlanStatus();
    expect(s.trades_completed).toBe(2);
    expect(s.remaining).toBe(3);
    expect(s.progress_pct).toBe(40);
  });
});

describe("resetTradingPlan", () => {
  it("resets trades_completed to 0 and clears completed_at", () => {
    initTradingPlan();
    for (let i = 0; i < 5; i++) recordTrade({});
    const reset = resetTradingPlan();
    expect(reset.trades_completed).toBe(0);
    expect(reset.session_complete).toBe(false);
    expect(reset.completed_at).toBeNull();
  });

  it("session_id is a non-empty string after reset", () => {
    const after = resetTradingPlan();
    expect(typeof after.session_id).toBe("string");
    expect(after.session_id.length).toBeGreaterThan(0);
  });
});
