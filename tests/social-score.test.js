// Tests for social-hunter.js getSocialScore — specifically the mint-based
// matching that prevents impersonator tokens from inheriting a real coin's
// social score.

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

const SIGNALS = [
  { symbol: "PEPE", mint: "PEPEmint111111111111111111111111111111111111", socialScore: 80, mentions: 5 },
  { symbol: "BONK", mint: "BONKmint111111111111111111111111111111111111", socialScore: 60, mentions: 3 },
  { symbol: "OLDCOIN", socialScore: 40, mentions: 2 }, // old cache entry — no mint field
];

// Mock the file system so we control the cache
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify({ signals: SIGNALS, updatedAt: new Date().toISOString() })),
  };
});
vi.mock("../logger.js",      () => ({ log: vi.fn() }));
vi.mock("../atomic-write.js",() => ({ atomicWriteJson: vi.fn(), withFileLock: vi.fn(async (_, fn) => fn()) }));
vi.mock("../social-trash-gate.js", () => ({ gateSignal: vi.fn(() => ({ pass: true })) }));

const { getSocialScore } = await import("../social-hunter.js");

describe("getSocialScore — basic lookup", () => {
  it("returns 0 for empty symbol", () => {
    expect(getSocialScore("")).toBe(0);
    expect(getSocialScore(null)).toBe(0);
    expect(getSocialScore(undefined)).toBe(0);
  });

  it("returns score when symbol matches (case-insensitive)", () => {
    expect(getSocialScore("pepe")).toBe(80);
    expect(getSocialScore("PEPE")).toBe(80);
    expect(getSocialScore("Pepe")).toBe(80);
  });

  it("returns 0 for unknown symbol", () => {
    expect(getSocialScore("UNKNOWN")).toBe(0);
  });
});

describe("getSocialScore — mint matching (T3-4 fix)", () => {
  it("matches when correct mint provided", () => {
    expect(getSocialScore("PEPE", "PEPEmint111111111111111111111111111111111111")).toBe(80);
  });

  it("blocks impersonator: same symbol, different mint → returns 0", () => {
    const impostorMint = "FAKEmint111111111111111111111111111111111111";
    expect(getSocialScore("PEPE", impostorMint)).toBe(0);
  });

  it("returns score when no mint provided (backward compat — symbol-only match)", () => {
    expect(getSocialScore("PEPE")).toBe(80);
    expect(getSocialScore("BONK")).toBe(60);
  });

  it("old cache entry without mint field matches by symbol for any mint (backward compat)", () => {
    // OLDCOIN has no mint field — should match regardless of what mint caller passes
    expect(getSocialScore("OLDCOIN", "ANYmint111111111111111111111111111111111111")).toBe(40);
    expect(getSocialScore("OLDCOIN")).toBe(40);
  });

  it("two tokens with same symbol: correct mint wins, impostor loses", () => {
    const realMint    = "BONKmint111111111111111111111111111111111111";
    const impostorMint = "FAKEBONKmint111111111111111111111111111111";
    expect(getSocialScore("BONK", realMint)).toBe(60);
    expect(getSocialScore("BONK", impostorMint)).toBe(0);
  });
});
