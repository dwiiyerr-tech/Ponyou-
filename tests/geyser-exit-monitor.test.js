import { describe, expect, it, vi } from "vitest";
import { attachExitMonitor, checkPriceDrop } from "../geyser-exit-monitor.js";

describe("geyser-exit-monitor", () => {
  it("checkPriceDrop: triggers emergency on -30% or worse", () => {
    const cb = vi.fn();
    const pos = { mint: "MINT123456789012345678901234567890123456789012", entry_price: 1.0 };
    expect(checkPriceDrop(pos, 0.69, cb)).toBe(true);
    expect(cb).toHaveBeenCalledWith(pos.mint, "price_drop", expect.stringContaining("%"));
  });

  it("checkPriceDrop: no trigger on small drop", () => {
    const cb = vi.fn();
    const pos = { mint: "MINT123456789012345678901234567890123456789012", entry_price: 1.0 };
    expect(checkPriceDrop(pos, 0.80, cb)).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("checkPriceDrop: handles missing entry_price gracefully", () => {
    const cb = vi.fn();
    expect(checkPriceDrop({}, 0.5, cb)).toBe(false);
    expect(checkPriceDrop(null, 0.5, cb)).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("attachExitMonitor: returns cleanup function when no stream", () => {
    const cleanup = attachExitMonitor(null, () => [], {});
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
  });

  it("attachExitMonitor: wraps onEvent and restores on cleanup", () => {
    const original = vi.fn();
    const stream = { onEvent: original };
    const cleanup = attachExitMonitor(stream, () => [], {});
    expect(stream.onEvent).not.toBe(original);
    cleanup();
    expect(stream.onEvent).toBe(original);
  });

  it("attachExitMonitor: triggers exit on large dump exceeding dynamic 1% supply threshold", async () => {
    const stream = { onEvent: vi.fn() };
    const onEmergencyExit = vi.fn();
    const positions = [{ mint: "TOKEN_A", total_supply: 50_000_000 }];
    const cleanup = attachExitMonitor(stream, () => positions, { onEmergencyExit });

    // 1% of 50M is 500k. A dump of 600k should trigger it.
    await stream.onEvent({
      kind: "swap",
      token_in: "TOKEN_A",
      token_out: "So11111111111111111111111111111111111111112",
      amount_in: 600_000,
    });
    expect(onEmergencyExit).toHaveBeenCalledWith("TOKEN_A", "liquidity_removal", expect.stringContaining("600,000"));

    // A dump of 400k should NOT trigger it.
    onEmergencyExit.mockClear();
    await stream.onEvent({
      kind: "swap",
      token_in: "TOKEN_A",
      token_out: "So11111111111111111111111111111111111111112",
      amount_in: 400_000,
    });
    expect(onEmergencyExit).not.toHaveBeenCalled();

    cleanup();
  });
});
