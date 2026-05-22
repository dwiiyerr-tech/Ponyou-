import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";

vi.mock("fs");

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockImplementation(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
});

import { isPartialTPLanded, markPartialTPLanded, clearPartialTPGuard, prunePartialTPGuard } from "../partial-tp-guard.js";

describe("isPartialTPLanded", () => {
  it("returns false when no state exists", () => {
    expect(isPartialTPLanded("mint::wallet", 1)).toBe(false);
  });

  it("returns true after markPartialTPLanded", () => {
    let stored = {};
    vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(stored));
    vi.mocked(fs.writeFileSync).mockImplementation((_, data) => { stored = JSON.parse(data); });

    markPartialTPLanded("pos1", 1);
    expect(isPartialTPLanded("pos1", 1)).toBe(true);
  });

  it("different attempt key does not block", () => {
    let stored = {};
    vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(stored));
    vi.mocked(fs.writeFileSync).mockImplementation((_, data) => { stored = JSON.parse(data); });

    markPartialTPLanded("pos1", 1);
    expect(isPartialTPLanded("pos1", 2)).toBe(false);
  });
});

describe("clearPartialTPGuard", () => {
  it("removes all entries for a position", () => {
    let stored = {};
    vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(stored));
    vi.mocked(fs.writeFileSync).mockImplementation((_, data) => { stored = JSON.parse(data); });

    markPartialTPLanded("pos2", 1);
    markPartialTPLanded("pos2", 2);
    clearPartialTPGuard("pos2");
    expect(isPartialTPLanded("pos2", 1)).toBe(false);
    expect(isPartialTPLanded("pos2", 2)).toBe(false);
  });
});

describe("prunePartialTPGuard", () => {
  it("removes entries older than maxAgeDays", () => {
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    let stored = { "old::1": { landed: true, ts: old } };
    vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(stored));
    vi.mocked(fs.writeFileSync).mockImplementation((_, data) => { stored = JSON.parse(data); });

    const pruned = prunePartialTPGuard(7);
    expect(pruned).toBe(1);
    expect(Object.keys(stored)).toHaveLength(0);
  });
});
