import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTEL_FILE = path.join(__dirname, "..", "market-intel.json");

function cleanIntel() {
  try { fs.unlinkSync(INTEL_FILE); } catch (_) {}
}

beforeEach(cleanIntel);
afterEach(cleanIntel);

describe("market-intelligence — getMarketIntelligence", () => {
  it("returns default intel when no data exists", async () => {
    const { getMarketIntelligence } = await import("../market-intelligence.js");
    const intel = getMarketIntelligence();
    expect(intel).toBeDefined();
    expect(intel.condition).toBe("NORMAL");
    expect(intel.description).toBeTruthy();
  });
});

describe("market-intelligence — getMarketTrend", () => {
  it("returns a trend object with UNKNOWN when no snapshots", async () => {
    const { getMarketTrend } = await import("../market-intelligence.js");
    const trend = getMarketTrend();
    expect(trend.trend).toBe("UNKNOWN");
    expect(trend.snapshots).toBe(0);
  });
});

describe("market-intelligence — exports", () => {
  it("exports all expected functions", async () => {
    const mod = await import("../market-intelligence.js");
    expect(typeof mod.getMarketIntelligence).toBe("function");
    expect(typeof mod.analyzeMarketCondition).toBe("function");
    expect(typeof mod.recordMarketSnapshot).toBe("function");
    expect(typeof mod.recordMarketResearchEnrichment).toBe("function");
    expect(typeof mod.getRecommendedAdjustments).toBe("function");
    expect(typeof mod.applyMarketAdjustments).toBe("function");
    expect(typeof mod.getMarketTrend).toBe("function");
  });
});

describe("market-intelligence — recordMarketSnapshot", () => {
  it("persists a snapshot and updates condition", async () => {
    const { recordMarketSnapshot, getMarketIntelligence } = await import("../market-intelligence.js");
    await recordMarketSnapshot([
      { swaps: 2000, buys: 1200, mc: 5000 },
      { swaps: 3000, buys: 1800, mc: 8000 },
    ]);
    const intel = getMarketIntelligence();
    expect(intel.condition).toBeTruthy();
    expect(["EXTREME", "HOT", "NORMAL", "COLD", "DEAD"]).toContain(intel.condition);
  });
});

describe("market-intelligence — analyzeMarketCondition", () => {
  it("returns HOT for active tokens", async () => {
    const { analyzeMarketCondition } = await import("../market-intelligence.js");
    const result = analyzeMarketCondition([
      { swaps: 2000, buys: 1200, mc: 5000 },
      { swaps: 3000, buys: 1800, mc: 8000 },
      { swaps: 2500, buys: 1500, mc: 6000 },
    ]);
    expect(result).toBeDefined();
    expect(result.condition).toBeTruthy();
    expect(["EXTREME", "HOT", "NORMAL", "COLD", "DEAD"]).toContain(result.condition);
  });

  it("returns COLD/DEAD for near-zero swaps", async () => {
    const { analyzeMarketCondition } = await import("../market-intelligence.js");
    const result = analyzeMarketCondition([
      { swaps: 5, buys: 2, mc: 100 },
      { swaps: 8, buys: 3, mc: 200 },
    ]);
    expect(["COLD", "DEAD"]).toContain(result.condition);
  });
});

describe("market-intelligence — getRecommendedAdjustments", () => {
  it("returns adjustments object for a given condition", async () => {
    const { getRecommendedAdjustments } = await import("../market-intelligence.js");
    const adj = getRecommendedAdjustments("HOT");
    expect(adj).toBeDefined();
    expect(adj.minMcap).toBeGreaterThan(0);
  });
});
