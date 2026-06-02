import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAN_FILE = path.join(__dirname, "..", "trading-plan.json");

function cleanPlan() {
  try { fs.unlinkSync(PLAN_FILE); } catch (_) {}
}

beforeEach(cleanPlan);
afterEach(cleanPlan);

describe("trading-plan — buildCompoundSchedule", () => {
  it("returns 30-day schedule by default", async () => {
    const { buildCompoundSchedule } = await import("../trading-plan.js");
    const schedule = buildCompoundSchedule(100, 1); // $100 capital, 1% daily
    expect(schedule).toHaveLength(30);
    expect(schedule[0].day).toBe(1);
    expect(schedule[0].start_usd).toBe(100);
  });

  it("compounds capital daily", async () => {
    const { buildCompoundSchedule } = await import("../trading-plan.js");
    const schedule = buildCompoundSchedule(100, 10); // 10% daily
    expect(schedule[0].target_usd).toBeCloseTo(110, 1);
    expect(schedule[1].start_usd).toBeCloseTo(110, 1);
    expect(schedule[1].target_usd).toBeCloseTo(121, 1);
  });

  it("custom day count", async () => {
    const { buildCompoundSchedule } = await import("../trading-plan.js");
    const schedule = buildCompoundSchedule(100, 1, 7);
    expect(schedule).toHaveLength(7);
  });

  it("handles 0% daily target", async () => {
    const { buildCompoundSchedule } = await import("../trading-plan.js");
    const schedule = buildCompoundSchedule(100, 0, 5);
    for (const day of schedule) {
      expect(day.start_usd).toBe(100);
    }
  });

  it("handles negative daily target", async () => {
    const { buildCompoundSchedule } = await import("../trading-plan.js");
    const schedule = buildCompoundSchedule(100, -5, 3);
    expect(schedule[0].target_usd).toBeLessThan(100);
  });

  it("all values are finite numbers", async () => {
    const { buildCompoundSchedule } = await import("../trading-plan.js");
    const schedule = buildCompoundSchedule(1000, 2, 10);
    for (const day of schedule) {
      expect(Number.isFinite(day.start_usd)).toBe(true);
      expect(Number.isFinite(day.target_usd)).toBe(true);
      expect(Number.isFinite(day.profit_needed_usd)).toBe(true);
    }
  });

  it("large schedule stays within reasonable bounds", async () => {
    const { buildCompoundSchedule } = await import("../trading-plan.js");
    const schedule = buildCompoundSchedule(100, 1, 100);
    expect(schedule).toHaveLength(100);
    // With 1% daily compounding for 100 days: 100 * (1.01)^100 ≈ 270
    expect(schedule[99].target_usd).toBeLessThan(300);
  });
});

describe("trading-plan — plan lifecycle", () => {
  it("exports expected functions", async () => {
    const mod = await import("../trading-plan.js");
    expect(typeof mod.buildCompoundSchedule).toBe("function");
  });

  it("getTradingPlan returns null when no plan exists", async () => {
    const { getTradingPlan } = await import("../trading-plan.js");
    expect(getTradingPlan()).toBeNull();
  });

  it("initTradingPlan creates and returns a plan", async () => {
    const { initTradingPlan, getTradingPlan } = await import("../trading-plan.js");
    const plan = await initTradingPlan({
      initialCapitalUsd: 500,
      dailyTargetPct: 1.5,
      days: 3,
    });
    expect(plan).toBeDefined();
    if (plan) {
      expect(plan.initialCapitalUsd).toBe(500);
      expect(plan.dailyTargetPct).toBe(1.5);
      expect(plan.days).toBe(3);
    }
    const loaded = getTradingPlan();
    expect(loaded).toBeDefined();
    if (loaded) {
      expect(loaded.schedule).toHaveLength(3);
    }
  });
});

// BUG 2 regression: the date-mismatch recalibration (trading-plan.js:~178)
// forces session.calibrated=false when session.date !== today. If the
// recalibration path did NOT stamp session.date = today, every subsequent
// updateSessionCapital() call would see the same stale date, recalibrate
// again, and reset the daily P&L baseline forever — an infinite recalibration
// loop. These tests pin session.date = today after recalibration.
describe("trading-plan — recalibration date stamp (BUG 2)", () => {
  const today = new Date().toISOString().slice(0, 10);

  it("first calibration stamps session.date = today", async () => {
    const { initTradingPlan, updateSessionCapital, getTradingPlan } = await import("../trading-plan.js");
    await initTradingPlan({ initialCapitalUsd: 100, dailyTargetPct: 1, days: 3 });

    const res = updateSessionCapital(100);
    expect(res.action).toBe("calibrated");

    const plan = getTradingPlan();
    expect(plan.session.date).toBe(today);
    expect(plan.session.calibrated).toBe(true);
    expect(plan.session.startCapitalUsd).toBe(100);
  });

  it("a stale session date recalibrates ONCE then stamps today (no loop)", async () => {
    const { initTradingPlan, updateSessionCapital, getTradingPlan } = await import("../trading-plan.js");
    await initTradingPlan({ initialCapitalUsd: 100, dailyTargetPct: 1, days: 3 });

    // Seed a calibrated session dated yesterday — the crash-restart scenario.
    const plan = getTradingPlan();
    plan.session.calibrated = true;
    plan.session.startCapitalUsd = 50;
    plan.session.currentCapitalUsd = 50;
    plan.session.date = "2000-01-01"; // far in the past
    fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));

    // First call: detects date mismatch, recalibrates to live wallet value,
    // and MUST stamp today's date.
    const first = updateSessionCapital(120);
    expect(first.action).toBe("calibrated");
    const afterFirst = getTradingPlan();
    expect(afterFirst.session.date).toBe(today);
    expect(afterFirst.session.startCapitalUsd).toBe(120);

    // Second call: same day, no mismatch → must NOT recalibrate again.
    // If the loop fix were missing, this would re-calibrate and reset the
    // baseline, reporting action "calibrated" + pnl 0 instead of a real P&L.
    const second = updateSessionCapital(150);
    expect(second.action).not.toBe("calibrated");
    const afterSecond = getTradingPlan();
    expect(afterSecond.session.startCapitalUsd).toBe(120); // baseline preserved
    expect(afterSecond.session.profitUsd).toBeCloseTo(30, 4); // 150 - 120
  });
});
