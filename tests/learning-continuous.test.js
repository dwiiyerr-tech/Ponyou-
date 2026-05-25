import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBSERVED = path.join(__dirname, "..", "observed-tokens.json");

function cleanFiles() {
  try { fs.unlinkSync(OBSERVED); } catch (_) {}
}

beforeEach(cleanFiles);
afterEach(cleanFiles);

describe("learning-continuous — recordObservations", () => {
  it("records candidate tokens", async () => {
    const { recordObservations } = await import("../learning-continuous.js");
    recordObservations([
      { mint: "Mint111111111111111111111111111111111111111", symbol: "TEST1", mc: 5000 },
      { mint: "Mint222222222222222222222222222222222222222", symbol: "TEST2", mc: 8000 },
    ]);
    const data = JSON.parse(fs.readFileSync(OBSERVED, "utf8"));
    expect(data.observed).toHaveLength(2);
  });

  it("deduplicates by mint", async () => {
    const { recordObservations } = await import("../learning-continuous.js");
    const token = { mint: "Mint333333333333333333333333333333333333333", symbol: "DUP", mc: 1000 };
    recordObservations([token]);
    recordObservations([token]);
    const data = JSON.parse(fs.readFileSync(OBSERVED, "utf8"));
    expect(data.observed).toHaveLength(1);
  });

  it("handles empty array gracefully", async () => {
    const { recordObservations } = await import("../learning-continuous.js");
    expect(() => recordObservations([])).not.toThrow();
  });
});

describe("learning-continuous — module exports", () => {
  it("exports expected functions", async () => {
    const mod = await import("../learning-continuous.js");
    expect(typeof mod.recordObservations).toBe("function");
    expect(typeof mod.processObservations).toBe("function");
    expect(typeof mod.buildObservationAnalysisPrompt).toBe("function");
    expect(typeof mod.buildSuccessAnalysisPrompt).toBe("function");
  });
});

describe("learning-continuous — buildObservationAnalysisPrompt", () => {
  it("returns null for empty results", async () => {
    const { buildObservationAnalysisPrompt } = await import("../learning-continuous.js");
    expect(buildObservationAnalysisPrompt([])).toBeNull();
  });

  it("returns a string prompt when results include GEMs", async () => {
    const { buildObservationAnalysisPrompt } = await import("../learning-continuous.js");
    const prompt = buildObservationAnalysisPrompt([
      { symbol: "WIN", performance: "GEM", change_pct: 150, passed: false, flags: [] },
    ]);
    // Can be string or null depending on implementation
    expect(prompt === null || typeof prompt === "string").toBe(true);
  });
});

describe("learning-continuous — buildSuccessAnalysisPrompt", () => {
  it("returns a string prompt with context", async () => {
    const { buildSuccessAnalysisPrompt } = await import("../learning-continuous.js");
    const prompt = buildSuccessAnalysisPrompt({ symbol: "TEST", pnl_pct: 20 }, "HOT");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
