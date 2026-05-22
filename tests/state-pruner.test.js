import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies before importing the module under test ──────────────

vi.mock("fs");
vi.mock("../state.js", () => ({
  getState: vi.fn(),
}));

import fs from "fs";
import { getState } from "../state.js";
import { pruneClosedPositions } from "../state-pruner.js";

// Helper: ISO timestamp N days ago
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// Shared state reference mutated per test
let mockState;

beforeEach(() => {
  vi.clearAllMocks();

  // Default: no archive file on disk
  fs.existsSync.mockReturnValue(false);
  fs.readFileSync.mockReturnValue("[]");
  fs.writeFileSync.mockImplementation(() => {});

  mockState = { positions: {}, recentEvents: [], lastUpdated: null };
  getState.mockReturnValue(mockState);
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("pruneClosedPositions", () => {
  it("skips open positions regardless of age", () => {
    mockState.positions = {
      "mint1": {
        position: "mint1",
        closed: false,
        closed_at: null,
        deployed_at: daysAgo(30),
      },
    };

    const result = pruneClosedPositions(7);

    expect(result).toEqual({ pruned: 0, archived: 0 });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("archives closed positions older than maxAgeDays", () => {
    mockState.positions = {
      "oldMint": {
        position: "oldMint",
        closed: true,
        closed_at: daysAgo(10), // 10 days ago — older than 7
        deployed_at: daysAgo(15),
        amount_sol: 0.5,
      },
    };

    const result = pruneClosedPositions(7);

    expect(result).toEqual({ pruned: 1, archived: 1 });

    // Archive file should have been written with 1 entry
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2); // archive + state
    const archiveCall = fs.writeFileSync.mock.calls[0];
    const archived = JSON.parse(archiveCall[1]);
    expect(archived).toHaveLength(1);
    expect(archived[0].position).toBe("oldMint");
    expect(archived[0].archived_at).toBeDefined();

    // Position should be removed from state
    expect(mockState.positions).not.toHaveProperty("oldMint");
  });

  it("keeps closed positions newer than maxAgeDays", () => {
    mockState.positions = {
      "recentMint": {
        position: "recentMint",
        closed: true,
        closed_at: daysAgo(3), // only 3 days ago — within 7-day window
        deployed_at: daysAgo(5),
      },
    };

    const result = pruneClosedPositions(7);

    expect(result).toEqual({ pruned: 0, archived: 0 });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(mockState.positions).toHaveProperty("recentMint");
  });

  it("returns correct counts when a mix of open, recent-closed, and old-closed positions exist", () => {
    mockState.positions = {
      "openPos":   { position: "openPos",   closed: false, closed_at: null,         deployed_at: daysAgo(20) },
      "recentPos": { position: "recentPos", closed: true,  closed_at: daysAgo(2),   deployed_at: daysAgo(5) },
      "oldPos1":   { position: "oldPos1",   closed: true,  closed_at: daysAgo(8),   deployed_at: daysAgo(10) },
      "oldPos2":   { position: "oldPos2",   closed: true,  closed_at: daysAgo(14),  deployed_at: daysAgo(20) },
    };

    const result = pruneClosedPositions(7);

    expect(result).toEqual({ pruned: 2, archived: 2 });

    // Open and recent-closed positions must survive
    expect(mockState.positions).toHaveProperty("openPos");
    expect(mockState.positions).toHaveProperty("recentPos");
    expect(mockState.positions).not.toHaveProperty("oldPos1");
    expect(mockState.positions).not.toHaveProperty("oldPos2");

    // Archive should contain exactly 2 entries
    const archiveCall = fs.writeFileSync.mock.calls[0];
    const archived = JSON.parse(archiveCall[1]);
    expect(archived).toHaveLength(2);
  });

  it("appends to an existing archive instead of overwriting it", () => {
    const existingEntry = {
      position: "veryOldPos",
      closed: true,
      closed_at: daysAgo(30),
      archived_at: daysAgo(23),
    };

    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify([existingEntry]));

    mockState.positions = {
      "anotherOldMint": {
        position: "anotherOldMint",
        closed: true,
        closed_at: daysAgo(10),
        deployed_at: daysAgo(15),
      },
    };

    const result = pruneClosedPositions(7);

    expect(result).toEqual({ pruned: 1, archived: 1 });

    const archiveCall = fs.writeFileSync.mock.calls[0];
    const archived = JSON.parse(archiveCall[1]);
    // Existing entry preserved + new one appended
    expect(archived).toHaveLength(2);
    expect(archived[0].position).toBe("veryOldPos");
    expect(archived[1].position).toBe("anotherOldMint");
  });
});
