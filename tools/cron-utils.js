/**
 * cron-utils.js — UTC-pinned scheduling for daily jobs.
 *
 * node-cron evaluates expressions in the SYSTEM timezone. This host runs at
 * +0800, so every daily job documented as "UTC" (plan auto-advance at
 * midnight UTC, daily report at config.report.hourUtc, ...) actually fired
 * 8 hours late. Interval-style jobs (*​/N) are phase-shifted only and don't
 * need pinning.
 */
import nodeCron from "node-cron";

export const UTC_TZ = "Etc/UTC";

/** cron.schedule, but the expression is evaluated against UTC wall-clock. */
export function scheduleUtc(expression, fn, cronLib = nodeCron) {
  return cronLib.schedule(expression, fn, { timezone: UTC_TZ });
}
