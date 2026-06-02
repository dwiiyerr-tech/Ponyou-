import { describe, it, expect } from "vitest";
import { stripSensitive, isSensitiveKey, EXPLICIT_SENSITIVE } from "../dashboard/sensitive.js";

describe("isSensitiveKey", () => {
  it("returns true for all EXPLICIT_SENSITIVE keys", () => {
    for (const key of EXPLICIT_SENSITIVE) {
      expect(isSensitiveKey(key), `expected ${key} to be sensitive`).toBe(true);
    }
  });

  it("detects pattern matches case-insensitively", () => {
    expect(isSensitiveKey("GMGN_API_KEY")).toBe(true);
    expect(isSensitiveKey("myApiKey")).toBe(true);
    expect(isSensitiveKey("botToken")).toBe(true);
    expect(isSensitiveKey("bot_token")).toBe(true);
    expect(isSensitiveKey("user_password")).toBe(true);
    expect(isSensitiveKey("PRIVATE_KEY")).toBe(true);
    expect(isSensitiveKey("seedPhrase")).toBe(true);
  });

  it("returns false for safe non-sensitive keys", () => {
    expect(isSensitiveKey("mint")).toBe(false);
    expect(isSensitiveKey("balance")).toBe(false);
    expect(isSensitiveKey("publicKey")).toBe(false);
    expect(isSensitiveKey("tokenAddress")).toBe(false);
    expect(isSensitiveKey("strategy")).toBe(false);
  });

  it("respects SAFE_PATTERN_EXCEPTIONS (publicApiKey)", () => {
    expect(isSensitiveKey("publicApiKey")).toBe(false);
  });
});

describe("stripSensitive", () => {
  it("redacts explicit sensitive keys", () => {
    const result = stripSensitive({ apiKey: "abc123", walletKey: "key" });
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.walletKey).toBe("[REDACTED]");
  });

  it("preserves non-sensitive keys", () => {
    const result = stripSensitive({ mint: "abc", balance: 1.5, strategy: "alpha" });
    expect(result).toEqual({ mint: "abc", balance: 1.5, strategy: "alpha" });
  });

  it("leaves null and empty string values intact even for sensitive keys (UX: shows not configured)", () => {
    const result = stripSensitive({ apiKey: null, walletKey: "" });
    expect(result.apiKey).toBeNull();
    expect(result.walletKey).toBe("");
  });

  it("recursively redacts nested objects", () => {
    const result = stripSensitive({ config: { apiKey: "secret", name: "ponyou" } });
    expect(result.config.apiKey).toBe("[REDACTED]");
    expect(result.config.name).toBe("ponyou");
  });

  it("recursively handles arrays", () => {
    const result = stripSensitive({ tokens: [{ apiKey: "x", mint: "abc" }] });
    expect(result.tokens[0].apiKey).toBe("[REDACTED]");
    expect(result.tokens[0].mint).toBe("abc");
  });

  it("handles circular references without throwing", () => {
    const obj = { name: "test", apiKey: "secret" };
    obj.self = obj;
    const result = stripSensitive(obj);
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.name).toBe("test");
    expect(result.self).toBe("[Circular]");
  });

  it("returns primitives and null unchanged", () => {
    expect(stripSensitive(null)).toBeNull();
    expect(stripSensitive(42)).toBe(42);
    expect(stripSensitive("hello")).toBe("hello");
  });

  it("redacts pattern-matched keys in nested structure", () => {
    const result = stripSensitive({ wallet: { GMGN_API_KEY: "live_key", address: "abc" } });
    expect(result.wallet.GMGN_API_KEY).toBe("[REDACTED]");
    expect(result.wallet.address).toBe("abc");
  });
});
