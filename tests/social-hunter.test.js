/**
 * Tests for social-hunter.js and telegram.js parseCallSignal
 * P1-4: Signal parser is primary input surface for screening pipeline injection.
 */
import { describe, it, expect } from "vitest";
import { parseCallSignal } from "../telegram.js";

describe("telegram: parseCallSignal symbol extraction", () => {
  it("extracts $TICKER from a call message", () => {
    const signals = parseCallSignal({ text: "🟢 $PEPE is pumping — buy call", chat: { id: 123 } });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.some(s => s.symbol === "PEPE")).toBe(true);
    expect(signals[0].source).toBe("telegram");
  });

  it("extracts multiple symbols", () => {
    const signals = parseCallSignal({ text: "🚀 buy $WIF and $BONK — alpha call", chat: { id: 1 } });
    const syms = signals.map(s => s.symbol);
    expect(syms).toContain("WIF");
    expect(syms).toContain("BONK");
  });

  it("returns [] for non-call messages not forwarded", () => {
    const signals = parseCallSignal({ text: "Good morning!", chat: { id: 1 } });
    expect(signals).toEqual([]);
  });

  it("returns [] for empty text", () => {
    expect(parseCallSignal({ text: "", chat: { id: 1 } })).toEqual([]);
    expect(parseCallSignal({})).toEqual([]);
  });

  it("accepts forwarded messages without call keywords", () => {
    const signals = parseCallSignal({
      text: "$DOGE interesting",
      chat: { id: 1 },
      forward_from_chat: { id: 999, title: "Alpha Channel" },
      _forwardedFrom: "Alpha Channel",
    });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].isForwarded).toBe(true);
    expect(signals[0].forwardedFrom).toBe("Alpha Channel");
  });

  it("ignores words from IGNORE list", () => {
    const signals = parseCallSignal({
      text: "🚀 BUY THE FOMO is real — HODL $REALTOKEN",
      chat: { id: 1 },
    });
    const syms = signals.map(s => s.symbol);
    // These are in the IGNORE set:
    expect(syms).not.toContain("BUY");
    expect(syms).not.toContain("THE");
    expect(syms).not.toContain("FOMO");
    expect(syms).not.toContain("HODL");
    // Real symbol should pass:
    expect(syms).toContain("REALTOKEN");
  });

  it("symbol length bounds: 2–12 chars only", () => {
    const signals = parseCallSignal({ text: "🔥 call $VERYLONGSYMBOLXYZ and $A today", chat: { id: 1 } });
    signals.forEach(s => {
      expect(s.symbol.length).toBeGreaterThanOrEqual(2);
      expect(s.symbol.length).toBeLessThanOrEqual(12);
    });
  });

  it("text field is capped at 300 chars", () => {
    const longText = "🚀 buy $TOKEN " + "x".repeat(500);
    const signals = parseCallSignal({ text: longText, chat: { id: 1 } });
    signals.forEach(s => expect(s.text.length).toBeLessThanOrEqual(300));
  });

  it("includes chatId and views in output", () => {
    const signals = parseCallSignal({
      text: "🔥 call $MOON gem alpha",
      chat: { id: 42, title: "Alpha Calls" },
      views: 1234,
      date: Math.floor(Date.now() / 1000),
    });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].chatId).toBe("42");
    expect(signals[0].views).toBe(1234);
  });
});

describe("telegram: parseCallSignal injection resistance", () => {
  it("symbol regex only produces uppercase alpha tokens", () => {
    const signals = parseCallSignal({
      text: "🟢 buy $SAFE123 and <script>eval</script> $TOKEN call",
      chat: { id: 1 },
    });
    signals.forEach(s => {
      expect(/^[A-Z]+$/.test(s.symbol)).toBe(true);
    });
  });

  it("handles caption field (media messages)", () => {
    const signals = parseCallSignal({
      caption: "🚀 $CAPTOKEN alpha call gem",
      chat: { id: 1 },
    });
    expect(signals.some(s => s.symbol === "CAPTOKEN")).toBe(true);
  });

  it("postedAt is a valid ISO datetime", () => {
    const signals = parseCallSignal({
      text: "🔥 buy $MEME call",
      chat: { id: 1 },
      date: Math.floor(Date.now() / 1000),
    });
    expect(signals.length).toBeGreaterThan(0);
    expect(() => new Date(signals[0].postedAt)).not.toThrow();
    expect(new Date(signals[0].postedAt).toString()).not.toBe("Invalid Date");
  });
});
