import { describe, it, expect, beforeEach } from "vitest";
import { createRugCircuitBreaker } from "../rug-circuit-breaker.js";

const WINDOW_MS = 30 * 60 * 1000;
const LOCK_MS = 4 * 60 * 60 * 1000;

function makeCB(overrides = {}) {
  return createRugCircuitBreaker({ maxEvents: 3, windowMs: WINDOW_MS, lockDurationMs: LOCK_MS, ...overrides });
}

describe("createRugCircuitBreaker", () => {
  let cb;
  beforeEach(() => { cb = makeCB(); });

  it("is not locked on creation", () => {
    expect(cb.isLocked()).toBe(false);
    expect(cb.getStatus().locked).toBe(false);
    expect(cb.getStatus().recentCount).toBe(0);
  });

  it("does not trip below maxEvents", () => {
    const t = 1000;
    cb.recordExit("mint1", "rug_monitor_dev_sell", t);
    cb.recordExit("mint2", "rug_monitor_lp_removed", t + 1);
    expect(cb.isLocked(t + 2)).toBe(false);
    expect(cb.getStatus(t + 2).recentCount).toBe(2);
  });

  it("trips when maxEvents reached within window", () => {
    const t = 1000;
    cb.recordExit("mint1", "rug_force_exit", t);
    cb.recordExit("mint2", "rug_force_exit", t + 1);
    const result = cb.recordExit("mint3", "rug_force_exit", t + 2);

    expect(result.tripped).toBe(true);
    expect(cb.isLocked(t + 3)).toBe(true);
  });

  it("stays locked until lockDurationMs expires", () => {
    const t = 0;
    cb.recordExit("mint1", "rug_force_exit", t);
    cb.recordExit("mint2", "rug_force_exit", t + 1);
    cb.recordExit("mint3", "rug_force_exit", t + 2);

    // Lock was set at t+2, expires at t+2+LOCK_MS
    expect(cb.isLocked(t + LOCK_MS)).toBe(true);
    expect(cb.isLocked(t + 2 + LOCK_MS + 1)).toBe(false);
  });

  it("does not trip when events fall outside the rolling window", () => {
    const old = 0;
    const now = WINDOW_MS + 1000;
    cb.recordExit("mint1", "rug_force_exit", old);
    cb.recordExit("mint2", "rug_force_exit", old + 1);
    // Third event is well outside the window from old events' perspective
    const result = cb.recordExit("mint3", "rug_force_exit", now);

    expect(result.tripped).toBe(false);
    expect(cb.getStatus(now).recentCount).toBe(1);
  });

  it("getStatus returns correct resumeInMin when locked", () => {
    const t = 0;
    cb.recordExit("a", "rug", t);
    cb.recordExit("b", "rug", t + 1);
    cb.recordExit("c", "rug", t + 2);

    const status = cb.getStatus(t + 3);
    expect(status.locked).toBe(true);
    expect(status.resumeInMin).toBeGreaterThan(0);
    expect(status.lockReason).toMatch(/rug exits/i);
  });

  it("reset clears lock and events", () => {
    const t = 0;
    cb.recordExit("a", "rug", t);
    cb.recordExit("b", "rug", t + 1);
    cb.recordExit("c", "rug", t + 2);
    expect(cb.isLocked(t + 3)).toBe(true);

    cb.reset();
    expect(cb.isLocked(t + 3)).toBe(false);
    expect(cb.getStatus(t + 3).recentCount).toBe(0);
  });
});
