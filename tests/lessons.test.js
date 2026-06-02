import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = process.env.PONYOU_LESSONS_FILE || path.join(__dirname, "..", "lessons.json");
const PERF_FILE = process.env.PONYOU_PERF_FILE || path.join(__dirname, "..", "performance.json");
const RUG_FILE = process.env.PONYOU_RUG_MEMORY_FILE || path.join(__dirname, "..", "rug-memory.json");
const DARWIN_FILE = process.env.PONYOU_DARWIN_FILE || path.join(__dirname, "..", "darwin-weights.json");

function cleanFiles() {
  try { fs.unlinkSync(LESSONS_FILE); } catch (_) {}
  try { fs.unlinkSync(PERF_FILE); } catch (_) {}
  try { fs.unlinkSync(RUG_FILE); } catch (_) {}
  try { fs.unlinkSync(DARWIN_FILE); } catch (_) {}
}

beforeEach(cleanFiles);
afterEach(cleanFiles);

describe("lessons — addLesson", () => {
  it("adds a lesson with auto-incrementing id", async () => {
    const { addLesson } = await import("../lessons.js");
    const id1 = addLesson("Test rule 1", ["tag1"]);
    const id2 = addLesson("Test rule 2", ["tag2"]);
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBe(id1 + 1);
  });

  it("respects role and pin options", async () => {
    const { addLesson, listLessons } = await import("../lessons.js");
    addLesson("Pinned rule", ["critical"], { role: "SCREENER", pinned: true });
    const lessons = listLessons({ pinned: true });
    expect(lessons).toHaveLength(1);
    expect(lessons[0].rule).toContain("Pinned rule");
    expect(lessons[0].pinned).toBe(true);
  });
});

describe("lessons — listLessons", () => {
  it("filters by role", async () => {
    const { addLesson, listLessons } = await import("../lessons.js");
    addLesson("R1", [], { role: "MANAGER" });
    addLesson("R2", [], { role: "SCREENER" });
    expect(listLessons({ role: "MANAGER" })).toHaveLength(1);
    expect(listLessons({ role: "SCREENER" })).toHaveLength(1);
  });

  it("filters by tag", async () => {
    const { addLesson, listLessons } = await import("../lessons.js");
    addLesson("R1", ["rug"]);
    addLesson("R2", ["dev"]);
    expect(listLessons({ tag: "rug" })).toHaveLength(1);
  });

  it("returns last N items up to limit", async () => {
    const { addLesson, listLessons } = await import("../lessons.js");
    for (let i = 0; i < 15; i++) addLesson(`Rule ${i}`);
    expect(listLessons({ limit: 5 })).toHaveLength(5);
  });
});

describe("lessons — pinLesson / unpinLesson", () => {
  it("pins and unpins a lesson", async () => {
    const { addLesson, pinLesson, unpinLesson, listLessons } = await import("../lessons.js");
    const id = addLesson("Pin me");
    pinLesson(id);
    expect(listLessons({ pinned: true })).toHaveLength(1);
    unpinLesson(id);
    expect(listLessons({ pinned: true })).toHaveLength(0);
  });

  it("returns error for unknown id", async () => {
    const { pinLesson } = await import("../lessons.js");
    const result = pinLesson(9999);
    expect(result.error).toBeTruthy();
  });
});

describe("lessons — removeLessonsByKeyword / clearAllLessons", () => {
  it("removes lessons matching keyword", async () => {
    const { addLesson, removeLessonsByKeyword } = await import("../lessons.js");
    addLesson("Buy the dip");
    addLesson("Sell the top");
    const removed = removeLessonsByKeyword("dip");
    expect(removed).toBe(1);
  });

  it("clearAllLessons removes everything", async () => {
    const { addLesson, clearAllLessons, listLessons } = await import("../lessons.js");
    addLesson("R1");
    addLesson("R2");
    clearAllLessons();
    expect(listLessons()).toHaveLength(0);
  });
});

describe("lessons — recordLessonOutcome", () => {
  it("updates success/failure counts for winning trade", async () => {
    const { addLesson, recordLessonOutcome } = await import("../lessons.js");
    const id = addLesson("Buy dips");
    recordLessonOutcome([id], 25); // +25% PnL = win
    // Re-load to check
    const { getLessonAnalytics } = await import("../lessons.js");
    const analytics = getLessonAnalytics();
    const lesson = analytics.find(l => l.id === id);
    expect(lesson.times_applied).toBe(1);
    expect(lesson.success_count).toBe(1);
    expect(lesson.failure_count).toBe(0);
    expect(lesson.win_rate).toBe(1);
  });

  it("updates failure count for losing trade", async () => {
    const { addLesson, recordLessonOutcome } = await import("../lessons.js");
    const id = addLesson("Bad rule");
    recordLessonOutcome([id], -15);
    const { getLessonAnalytics } = await import("../lessons.js");
    const lesson = getLessonAnalytics().find(l => l.id === id);
    expect(lesson.failure_count).toBe(1);
  });

  it("no-op for empty lessonIds", async () => {
    const { recordLessonOutcome } = await import("../lessons.js");
    // Should not throw
    recordLessonOutcome([], 10);
    recordLessonOutcome(null, 10);
  });

  it("auto-deprecates lessons with >30 uses and <40% win rate", async () => {
    const { addLesson, recordLessonOutcome } = await import("../lessons.js");
    const id = addLesson("Bad strat");
    // Apply 31 times with losses
    for (let i = 0; i < 31; i++) {
      recordLessonOutcome([id], -5);
    }
    const { getLessonAnalytics } = await import("../lessons.js");
    const lesson = getLessonAnalytics().find(l => l.id === id);
    expect(lesson.status).toBe("deprecated");
  });
});

describe("lessons — recordTradeOutcome", () => {
  it("records a trade in performance history", async () => {
    const { recordTradeOutcome, getPerformanceHistory } = await import("../lessons.js");
    recordTradeOutcome({
      mint: "Mint111111111111111111111111111111111111111",
      symbol: "TEST",
      entry_usd: 100,
      exit_usd: 120,
      pnl_pct: 20,
      hold_minutes: 5,
      exit_reason: "profit_target",
    });
    const history = getPerformanceHistory();
    expect(history).toHaveLength(1);
    expect(history[0].win).toBe(true);
    expect(history[0].pnl_pct).toBe(20);
  });

  it("triggers rug-detected auto-lesson", async () => {
    const { recordTradeOutcome, listLessons } = await import("../lessons.js");
    recordTradeOutcome({
      mint: "Mint222222222222222222222222222222222222222",
      symbol: "RUG",
      entry_usd: 50,
      exit_usd: 5,
      pnl_pct: -90,
      hold_minutes: 2,
      exit_reason: "rug_detected",
      rug_detected: true,
    });
    const lessons = listLessons({ tag: "rug" });
    expect(lessons.length).toBeGreaterThanOrEqual(1);
  });

  it("triggers auto-lesson for big fast losses", async () => {
    const { recordTradeOutcome, listLessons } = await import("../lessons.js");
    recordTradeOutcome({
      mint: "Mint333333333333333333333333333333333333333",
      symbol: "DUMP",
      entry_usd: 100,
      exit_usd: 70,
      pnl_pct: -30,
      hold_minutes: 3,
      exit_reason: "stop_loss",
    });
    const lessons = listLessons({ tag: "fast_dump" });
    expect(lessons.length).toBeGreaterThanOrEqual(1);
  });
});

describe("lessons — getPerformanceSummary", () => {
  it("returns 'No trade history yet' when empty", async () => {
    const { getPerformanceSummary } = await import("../lessons.js");
    expect(getPerformanceSummary()).toBe("No trade history yet.");
  });

  it("returns formatted summary with trades", async () => {
    const { recordTradeOutcome, getPerformanceSummary } = await import("../lessons.js");
    recordTradeOutcome({
      mint: "Mint444444444444444444444444444444444444444",
      entry_usd: 100,
      exit_usd: 110,
      pnl_pct: 10,
      hold_minutes: 10,
      exit_reason: "target",
    });
    const summary = getPerformanceSummary();
    expect(summary).toContain("Trades:");
    expect(summary).toContain("Win Rate");
  });
});
