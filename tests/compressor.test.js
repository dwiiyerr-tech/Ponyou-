import { describe, it, expect } from "vitest";
import { compressToolOutput } from "../compressor.js";

describe("compressor — compressToolOutput", () => {
  it("passes through non-object data", () => {
    expect(compressToolOutput(null, "test")).toBeNull();
    expect(compressToolOutput("string", "test")).toBe("string");
    expect(compressToolOutput(42, "test")).toBe(42);
  });

  it("compresses discover_tokens output", () => {
    const tokens = Array.from({ length: 20 }, (_, i) => ({
      mint: `mint${i}`,
      symbol: `SYM${i}`,
      mcap: 1000 + i * 10,
      swaps: i * 5,
      buys: i * 2,
      sells: i * 3,
      price_change_1h: i * 0.5,
      hot_level: i % 5,
      launchpad: "pump.fun",
      extra_field: "should be stripped",
    }));
    const result = compressToolOutput({ tokens }, "discover_tokens");
    expect(result.tokens.length).toBeLessThanOrEqual(6);
    expect(result.tokens[0].sym).toBeDefined();
    expect(result.tokens[0].extra_field).toBeUndefined();
    expect(result._rtk).toBeTruthy();
  });

  it("compresses get_token_holders output", () => {
    const holders = Array.from({ length: 15 }, (_, i) => ({
      address: `addr12345678901234567890${i}extra`,
      pct: 5,
      sol_balance: 10,
      tags: [],
      extra: "x",
    }));
    const result = compressToolOutput({ holders }, "get_token_holders");
    expect(result.holders.length).toBeLessThanOrEqual(5);
    expect(result.holders[0].address.length).toBeLessThan(15); // truncated
    expect(result._rtk).toBeTruthy();
  });

  it("compresses list_lessons output", () => {
    const lessons = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      rule: `Rule ${i}`,
      tags: ["t1"],
      extra: "strip",
    }));
    const result = compressToolOutput({ lessons }, "list_lessons");
    expect(result.lessons.length).toBeLessThanOrEqual(6);
    expect(result.lessons[0].id).toBeDefined();
    expect(result.lessons[0].rule).toBeDefined();
    expect(result.lessons[0].extra).toBeUndefined();
  });

  it("handles non-serializable data gracefully", () => {
    const obj = { a: 1 };
    obj.self = obj; // circular
    const result = compressToolOutput(obj, "any");
    expect(result._error).toBeTruthy();
  });

  it("truncates long strings in generic compression", () => {
    const data = { description: "x".repeat(500) };
    const result = compressToolOutput(data, "unknown_tool");
    expect(result.description.length).toBeLessThan(300);
    expect(result.description).toContain("Truncated");
  });

  it("strips null/undefined/empty values", () => {
    const data = { a: 1, b: null, c: undefined, d: "", e: "ok" };
    const result = compressToolOutput(data, "test");
    expect(result.a).toBe(1);
    expect(result.b).toBeUndefined();
    expect(result.c).toBeUndefined();
    expect(result.d).toBeUndefined();
    expect(result.e).toBe("ok");
  });
});
