/**
 * Cron timezone correctness (task #23) — daily jobs documented as UTC must be
 * evaluated against UTC wall-clock, not the host's +0800.
 */
import { describe, expect, it } from "vitest";
import { scheduleUtc, UTC_TZ } from "../tools/cron-utils.js";

describe("scheduleUtc", () => {
  it("pins the schedule to Etc/UTC", () => {
    const calls = [];
    const fake = { schedule: (expr, fn, opts) => { calls.push({ expr, fn, opts }); return { stop() {} }; } };
    const fn = () => {};
    scheduleUtc("1 0 * * *", fn, fake);
    expect(calls).toHaveLength(1);
    expect(calls[0].expr).toBe("1 0 * * *");
    expect(calls[0].fn).toBe(fn);
    expect(calls[0].opts).toEqual({ timezone: UTC_TZ });
  });

  it("real node-cron accepts the pinned timezone (would throw on an invalid tz)", () => {
    const task = scheduleUtc("0 4 * * *", () => {});
    expect(typeof task.stop).toBe("function");
    task.stop();
  });
});
