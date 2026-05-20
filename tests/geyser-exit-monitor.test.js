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
});
