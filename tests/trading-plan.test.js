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
