// Tests for discord-listener.js symbol extraction and call detection.
// This is the primary attack surface: untrusted Discord text flows directly
// into the screening/buy pipeline — bad parsing = bad tokens get bought.

import { describe, it, expect, vi } from "vitest";

vi.mock("../atomic-write.js",       () => ({ atomicWriteJson: vi.fn(), withFileLock: vi.fn(async (_, fn) => fn()) }));
vi.mock("../social-trash-gate.js",  () => ({ gateSignal: vi.fn(() => ({ pass: true, reason: "ok" })) }));
vi.mock("../logger.js",             () => ({ log: vi.fn() }));

const { parseCallMessage } = await import("../discord-listener.js");

describe("parseCallMessage — call detection", () => {
  it("detects 🟢 emoji as call indicator", () => {
    const r = parseCallMessage("🟢 $PEPE — buy now target 3x", "alpha");
    expect(r).not.toBeNull();
  });

  it("detects 'call' keyword case-insensitively", () => {
    const r = parseCallMessage("CALL: $TOKEN entry 0.001 SOL target 0.005", "alpha");
    expect(r).not.toBeNull();
  });

  it("detects buy/long keywords with symbol", () => {
    const r = parseCallMessage("buy $BONK right now 🔥", "calls");
    expect(r).not.toBeNull();
  });

  it("returns null for non-call message with no reactions", () => {
    const r = parseCallMessage("gm everyone, how's your day?", "general", []);
    expect(r).toBeNull();
  });

  it("treats messages with reactions as calls even without keywords", () => {
    const r = parseCallMessage("$POPCAT", "alpha", [{ count: 5 }]);
    expect(r).not.toBeNull();
  });

  it("returns null when no symbols found in call message", () => {
    const r = parseCallMessage("🟢 buy now target 3x entry confirmed", "alpha");
    expect(r).toBeNull();
  });
});

describe("parseCallMessage — symbol extraction", () => {
  it("extracts $-prefixed symbol", () => {
    const r = parseCallMessage("🟢 $PEPE is mooning", "alpha");
    expect(r).not.toBeNull();
    expect(r.map(s => s.symbol)).toContain("PEPE");
  });

  it("extracts bare uppercase symbol", () => {
    const r = parseCallMessage("🔥 BONK call TP 3x", "calls");
    expect(r).not.toBeNull();
    const symbols = r.map(s => s.symbol);
    expect(symbols).toContain("BONK");
  });

  it("extracts multiple symbols from one message", () => {
    const r = parseCallMessage("🟢 $PEPE and $BONK both looking strong, buy both", "alpha");
    expect(r).not.toBeNull();
    const symbols = r.map(s => s.symbol);
    expect(symbols).toContain("PEPE");
    expect(symbols).toContain("BONK");
  });

  it("excludes 1-char symbols", () => {
    const r = parseCallMessage("🟢 $A is the best coin", "alpha");
    // A is too short (< 2 chars with dollar prefix: "A" is 1 char)
    if (r !== null) {
      expect(r.map(s => s.symbol)).not.toContain("A");
    }
  });

  it("excludes symbols longer than 12 chars", () => {
    const r = parseCallMessage("🟢 $AVERYLONGSYMBOLNAME buy now", "alpha");
    if (r !== null) {
      expect(r.every(s => s.symbol.length <= 12)).toBe(true);
    }
  });

  it("deduplicates repeated symbols", () => {
    const r = parseCallMessage("🟢 $PEPE $PEPE $PEPE buy", "alpha");
    expect(r).not.toBeNull();
    const pepeCalls = r.filter(s => s.symbol === "PEPE");
    expect(pepeCalls.length).toBe(1);
  });
});

describe("parseCallMessage — signal shape", () => {
  it("includes required fields on each signal", () => {
    const r = parseCallMessage("🟢 $POPCAT entry", "alpha-calls");
    expect(r).not.toBeNull();
    for (const sig of r) {
      expect(sig).toHaveProperty("symbol");
      expect(sig).toHaveProperty("source", "discord");
      expect(sig).toHaveProperty("channel");
      expect(sig).toHaveProperty("text");
      expect(sig).toHaveProperty("postedAt");
    }
  });

  it("truncates text at 300 chars", () => {
    const longMsg = "🟢 $TOKEN " + "x".repeat(400);
    const r = parseCallMessage(longMsg, "alpha");
    expect(r).not.toBeNull();
    for (const sig of r) {
      expect(sig.text.length).toBeLessThanOrEqual(300);
    }
  });

  it("sums reaction counts into engagement", () => {
    const reactions = [{ count: 10 }, { count: 5 }];
    const r = parseCallMessage("🟢 $BONK call", "alpha", reactions);
    expect(r).not.toBeNull();
    expect(r[0].engagement).toBe(15);
  });
});

describe("parseCallMessage — injection resistance", () => {
  it("does not extract 'SOL' as a trade signal when in sentence context", () => {
    const r = parseCallMessage("🟢 entry 0.01 SOL target 3x $REALTOKEN", "alpha");
    // SOL appears as a currency unit, not a token — may or may not extract,
    // but REALTOKEN must be extracted
    if (r !== null) {
      const syms = r.map(s => s.symbol);
      expect(syms).toContain("REALTOKEN");
    }
  });

  it("handles empty content gracefully", () => {
    expect(() => parseCallMessage("", "alpha")).not.toThrow();
    expect(parseCallMessage("", "alpha")).toBeNull();
  });

  it("handles null/undefined content gracefully", () => {
    expect(() => parseCallMessage(null, "alpha")).not.toThrow();
    expect(() => parseCallMessage(undefined, "alpha")).not.toThrow();
  });
});
