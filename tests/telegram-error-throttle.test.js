/**
 * Error → Telegram throttle (task #12): a repeating error must not become one
 * chat message per occurrence — 142 identical CRON_ERROR messages flooded the
 * chat on 2026-06-08/09. First occurrence forwards; repeats inside the 15-min
 * window are suppressed and surface as a ×N annotation on the next forward.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { shouldForwardErrorToTelegram, _resetTelegramErrorThrottleForTests } from "../logger.js";

const MIN = 60 * 1000;

beforeEach(() => _resetTelegramErrorThrottleForTests());

describe("shouldForwardErrorToTelegram", () => {
  it("forwards the first occurrence", () => {
    const r = shouldForwardErrorToTelegram("cron_error", "boom", 0);
    expect(r.send).toBe(true);
    expect(r.suppressed).toBe(0);
  });

  it("suppresses identical repeats inside the window", () => {
    shouldForwardErrorToTelegram("cron_error", "boom", 0);
    for (let i = 1; i <= 10; i++) {
      const r = shouldForwardErrorToTelegram("cron_error", "boom", i * MIN);
      expect(r.send).toBe(false);
    }
  });

  it("forwards again after the window with the suppressed count", () => {
    shouldForwardErrorToTelegram("cron_error", "boom", 0);
    for (let i = 1; i <= 5; i++) shouldForwardErrorToTelegram("cron_error", "boom", i * MIN);
    const r = shouldForwardErrorToTelegram("cron_error", "boom", 16 * MIN);
    expect(r.send).toBe(true);
    expect(r.suppressed).toBe(5);
  });

  it("different messages are throttled independently", () => {
    shouldForwardErrorToTelegram("cron_error", "boom", 0);
    const r = shouldForwardErrorToTelegram("cron_error", "different failure", 1 * MIN);
    expect(r.send).toBe(true);
  });

  it("different categories are throttled independently", () => {
    shouldForwardErrorToTelegram("cron_error", "boom", 0);
    const r = shouldForwardErrorToTelegram("learning_error", "boom", 1 * MIN);
    expect(r.send).toBe(true);
  });

  it("matches on message prefix so changing tails (ids, counts) still dedupe", () => {
    const base = "x".repeat(80);
    shouldForwardErrorToTelegram("cron_error", base + " mint=AAA", 0);
    const r = shouldForwardErrorToTelegram("cron_error", base + " mint=BBB", 1 * MIN);
    expect(r.send).toBe(false);
  });

  it("keeps memory bounded at 200 keys", () => {
    for (let i = 0; i < 250; i++) shouldForwardErrorToTelegram("cat", `msg-${i}`, 0);
    // First keys evicted; re-sending an evicted key forwards again (fresh)
    const r = shouldForwardErrorToTelegram("cat", "msg-0", 1 * MIN);
    expect(r.send).toBe(true);
  });
});
