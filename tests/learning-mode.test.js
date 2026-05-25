import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARNING_STATE = path.join(__dirname, "..", "learning-state.json");
const LOSS_ANALYSIS = path.join(__dirname, "..", "loss-analysis.json");

function cleanFiles() {
  try { fs.unlinkSync(LEARNING_STATE); } catch (_) {}
  try { fs.unlinkSync(LOSS_ANALYSIS); } catch (_) {}
}

beforeEach(cleanFiles);
afterEach(cleanFiles);

describe("learning-mode — getLearningModeStatus", () => {
  it("returns inactive by default", async () => {
    const { getLearningModeStatus } = await import("../learning-mode.js");
    const status = getLearningModeStatus();
    expect(status.active).toBe(false);
  });
});

describe("learning-mode — activateLearningMode", () => {
  it("activates learning mode for a duration", async () => {
    const { activateLearningMode, getLearningModeStatus } = await import("../learning-mode.js");
    activateLearningMode({ mint: "MintAAA11111111111111111111111111111111111", pnl_pct: -25 }, "STOP_LOSS", 60);
    expect(getLearningModeStatus().active).toBe(true);
  });

  it("includes trigger type in state", async () => {
    const { activateLearningMode } = await import("../learning-mode.js");
    activateLearningMode({ consecutive_losses: 3 }, "SERIES_LOSS", 30);
    const state = JSON.parse(fs.readFileSync(LEARNING_STATE, "utf8"));
    expect(state.triggerType).toBe("SERIES_LOSS");
    expect(state.active).toBe(true);
  });
});

describe("learning-mode — deactivate via markAnalysisRun", () => {
  it("markAnalysisRun sets analysis flag", async () => {
    const { activateLearningMode, markAnalysisRun } = await import("../learning-mode.js");
    activateLearningMode({ pnl_pct: -15 }, "STOP_LOSS", 10);
    markAnalysisRun();
    const state = JSON.parse(fs.readFileSync(LEARNING_STATE, "utf8"));
    expect(state.analysisRun).toBe(true);
  });
});

describe("learning-mode — shouldRunAnalysis", () => {
  it("returns false when learning mode is inactive", async () => {
    const { shouldRunAnalysis } = await import("../learning-mode.js");
    expect(shouldRunAnalysis()).toBe(false);
  });

  it("returns true when active and analysis not yet run", async () => {
    const { activateLearningMode, shouldRunAnalysis } = await import("../learning-mode.js");
    activateLearningMode({ pnl_pct: -30 }, "STOP_LOSS", 60);
    expect(shouldRunAnalysis()).toBe(true);
  });
});

describe("learning-mode — getLearningStatusSummary", () => {
  it("returns summary with expected fields", async () => {
    const { getLearningStatusSummary } = await import("../learning-mode.js");
    const summary = getLearningStatusSummary();
    expect(summary).toBeDefined();
    expect(typeof summary.active).toBe("boolean");
    expect(summary.total_learning_events).toBeDefined();
  });
});

describe("learning-mode — exports", () => {
  it("exports all expected functions", async () => {
    const mod = await import("../learning-mode.js");
    expect(typeof mod.getLearningModeStatus).toBe("function");
    expect(typeof mod.activateLearningMode).toBe("function");
    expect(typeof mod.markAnalysisRun).toBe("function");
    expect(typeof mod.shouldRunAnalysis).toBe("function");
    expect(typeof mod.buildLossAnalysisPrompt).toBe("function");
    expect(typeof mod.recordLossAnalysis).toBe("function");
    expect(typeof mod.getActiveLossContext).toBe("function");
    expect(typeof mod.getLearningHistory).toBe("function");
    expect(typeof mod.getLearningStatusSummary).toBe("function");
  });
});
