import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../market-intelligence.js", () => ({
  getMarketIntelligence: vi.fn(),
}));

import fs from "fs";
import { getMarketIntelligence } from "../market-intelligence.js";

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
});

const { computeMarketRegime, getMaxPositions } = await import("../market-heatmap.js");

describe("computeMarketRegime", () => {
  it("maps DEAD → regime DEAD, maxPositions 1", () => {
    vi.mocked(getMarketIntelligence).mockReturnValue({ condition: "DEAD" });
    const r = computeMarketRegime();
    expect(r.regime).toBe("DEAD");
    expect(r.max_positions).toBe(1);
  });

  it("maps COLD → 2", () => {
    vi.mocked(getMarketIntelligence).mockReturnValue({ condition: "COLD" });
    expect(computeMarketRegime().max_positions).toBe(2);
  });

  it("maps NORMAL → 3", () => {
    vi.mocked(getMarketIntelligence).mockReturnValue({ condition: "NORMAL" });
    expect(computeMarketRegime().max_positions).toBe(3);
  });

  it("maps HOT → 4", () => {
    vi.mocked(getMarketIntelligence).mockReturnValue({ condition: "HOT" });
    expect(computeMarketRegime().max_positions).toBe(4);
  });

  it("maps EXTREME → FRENZY, maxPositions 5", () => {
    vi.mocked(getMarketIntelligence).mockReturnValue({ condition: "EXTREME" });
    const r = computeMarketRegime();
    expect(r.regime).toBe("FRENZY");
    expect(r.max_positions).toBe(5);
  });

  it("unknown condition falls back to NORMAL (3)", () => {
    vi.mocked(getMarketIntelligence).mockReturnValue({ condition: "UNKNOWN" });
    expect(computeMarketRegime().max_positions).toBe(3);
  });
});

describe("getMaxPositions", () => {
  it("returns heatmap value when fresh", () => {
    vi.mocked(getMarketIntelligence).mockReturnValue({ condition: "HOT" });
    let stored = {};
    vi.mocked(fs.writeFileSync).mockImplementation((_, data) => { stored = JSON.parse(data); });
    vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ ...stored, computed_at: Date.now() }));
    // compute first to seed state
    computeMarketRegime();
    expect(getMaxPositions(3)).toBe(4);
  });

  it("returns fallback on error", () => {
    vi.mocked(getMarketIntelligence).mockImplementation(() => { throw new Error("fail"); });
    expect(getMaxPositions(3)).toBe(3);
  });
});
