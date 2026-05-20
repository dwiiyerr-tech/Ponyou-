import { describe, expect, it } from "vitest";
import { buildRugMonitorConfig } from "../config.js";

describe("buildRugMonitorConfig", () => {
  it("provides safe defaults when block is missing", () => {
    const r = buildRugMonitorConfig({});
    expect(r.enabled).toBe(true);
    expect(r.pollingIntervalSec).toBe(30);
    expect(r.rateLimitLowSec).toBe(60);
    expect(r.devSellThresholds).toEqual({ low: -5, medium: -20, high: -50 });
    expect(r.lpMovementThresholds).toEqual({ low: -20, medium: -50, high: null });
    expect(r.holderDumpThresholds).toEqual({ low: -10, medium: -25, high: -50 });
    expect(r.actions.low).toEqual({ type: "tighten_trail", params: { trailingDeltaPct: -2 } });
    expect(r.actions.medium).toEqual({ type: "sell_partial", params: { fraction: 0.5 } });
    expect(r.actions.high).toEqual({ type: "sell_all" });
  });

  it("respects user overrides while keeping defaults for unspecified fields", () => {
    const r = buildRugMonitorConfig({ rugMonitor: { enabled: false, pollingIntervalSec: 15 } });
    expect(r.enabled).toBe(false);
    expect(r.pollingIntervalSec).toBe(15);
    expect(r.devSellThresholds).toEqual({ low: -5, medium: -20, high: -50 });
  });

  it("deep-merges nested threshold overrides", () => {
    const r = buildRugMonitorConfig({ rugMonitor: { devSellThresholds: { high: -40 } } });
    expect(r.devSellThresholds).toEqual({ low: -5, medium: -20, high: -40 });
  });
});
