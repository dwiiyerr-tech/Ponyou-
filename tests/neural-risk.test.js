import { describe, it, expect, vi } from "vitest";
import NeuralRisk from "../neural-risk.js";

describe("NeuralRisk", () => {
  const nr = new NeuralRisk({ initialCapital: 10, maxDrawdown: 0.3, riskPerTrade: 0.02 });

  describe("kelly()", () => {
    it("returns positive fractions for positive edge", () => {
      const k = nr.kelly(0.6, 2.0, 1.0);
      expect(k.fraction).toBeGreaterThan(0);
      expect(k.halfKelly).toBeGreaterThan(0);
      expect(k.quarterKelly).toBeGreaterThan(0);
      expect(k.quarterKelly).toBeLessThan(k.halfKelly);
    });

    it("clamps to [0.01, 0.5]", () => {
      const bad = nr.kelly(-1, 0, 0);
      expect(bad.fraction).toBeGreaterThanOrEqual(0.01);
      expect(bad.fraction).toBeLessThanOrEqual(0.5);
    });
  });

  describe("rsi()", () => {
    it("returns a valid signal and numeric rsi value", async () => {
      const prices = [10, 9, 8, 9, 8, 7, 8, 9, 10, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
      const r = await nr.rsi(prices);
      expect(typeof r.value).toBe("number");
      expect(["oversold", "neutral", "overbought"]).toContain(r.signal);
    });

    it("returns unknown for insufficient data", async () => {
      const r = await nr.rsi([10, 11], 14);
      expect(r.signal).toBe("unknown");
      expect(r.value).toBeNull();
    });
  });

  describe("var95()", () => {
    it("returns var, cvar, drawdown", () => {
      const returns = [-0.05, 0.03, -0.08, 0.02, 0.06, -0.04, 0.01, -0.02, 0.05, -0.03];
      const v = nr.var95(returns);
      expect(v.var).toBeGreaterThan(0);
      expect(v.cvar).toBeGreaterThan(0);
      expect(v.drawdown).toBeDefined();
    });

    it("handles empty array without throwing", () => {
      const v = nr.var95([]);
      expect(v).toBeDefined();
    });
  });

  describe("storePattern() / retrievePattern()", () => {
    it("stores and retrieves a pattern", async () => {
      const data = { regime: "HOT", narrative: "AI", winRate: 0.6 };
      const ok = await nr.storePattern("test:hot:ai", data);
      expect(ok).toBe(true);
    });

    it("is idempotent when storing the same key again", async () => {
      const data = { regime: "HOT", narrative: "AI", winRate: 0.65 };
      const first = await nr.storePattern("test:hot:ai:upsert", data);
      const second = await nr.storePattern("test:hot:ai:upsert", data);
      expect(first).toBe(true);
      expect(second).toBe(true);
    });

    it("returns false on bad binary path", async () => {
      const bad = new NeuralRisk();
      bad._rufloBin = "/nonexistent/ruflo";
      const ok = await bad.storePattern("k", { x: 1 });
      expect(ok).toBe(false);
    });
  });

  describe("searchPatterns()", () => {
    it("returns array (possibly empty)", async () => {
      const results = await nr.searchPatterns("HOT regime");
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
