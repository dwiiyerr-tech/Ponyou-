import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, logAction } from "../logger.js";

describe("logger — log", () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("writes to console with [TIMESTAMP] [CATEGORY] message format", () => {
    log("test_category", "test message");
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2}/);
    expect(call).toContain("[TEST_CATEGORY]");
    expect(call).toContain("test message");
  });

  it("sanitizes control characters from message", () => {
    log("info", "msg\nwith\r\nnewlines");
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    expect(call).not.toContain("\n");
    expect(call).not.toContain("\r");
  });

  it("truncates long messages", () => {
    log("info", "x".repeat(3000));
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    expect(call.length).toBeLessThan(2500);
  });

  it("redacts EVM private keys", () => {
    log("info", "key: 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    expect(call).toContain("key: [REDACTED]");
  });

  it("sanitizes category name to max 64 chars", () => {
    log("a".repeat(80), "msg");
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    // category is uppercased and max 64 chars in the output
    expect(call).not.toContain("A".repeat(65));
  });

  it("error level still logs with console.log", () => {
    log("error_crash", "something broke");
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    expect(call).toContain("[ERROR_CRASH]");
  });
});

describe("logger — logAction", () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("prefixes with tool name and success mark", () => {
    logAction({ tool: "swap_token", success: true, args: {}, result: {} });
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    expect(call).toContain("[swap_token]");
    expect(call).toContain("✓");
  });

  it("shows failure mark", () => {
    logAction({ tool: "close_position", success: false, args: {}, result: {} });
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    expect(call).toContain("✗");
  });

  it("includes duration when available", () => {
    logAction({ tool: "get_wallet_balance", success: true, duration_ms: 230, args: {}, result: {} });
    const call = consoleSpy.mock.calls[0]?.[0] || "";
    expect(call).toContain("230ms");
  });
});
