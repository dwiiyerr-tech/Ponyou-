import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { wrapRugMonitorCallbacks } from "../tools/realtime-intel-bridge.js";
import { _resetSlowRugForTests, evaluateSlowRug } from "../tools/slow-rug-detector.js";
import { _resetDevWalletStateForTests, evaluateDevActivity } from "../tools/dev-wallet-tracker.js";

beforeEach(() => {
  _resetSlowRugForTests();
  _resetDevWalletStateForTests();
});

afterEach(() => {
  _resetSlowRugForTests();
  _resetDevWalletStateForTests();
});

// Helper: a recording mark-for-exit function
function recordingMarker() {
  const calls = [];
  return {
    fn: (positionKey, reason) => calls.push({ positionKey, reason }),
    calls,
  };
}

// Async sleep — we fire events with await, but inner _handle* runs detached
async function flush() {
  // Allow microtasks + small file I/O to settle
  await new Promise((r) => setTimeout(r, 50));
}

describe("RT1: realtime-intel-bridge — passthrough", () => {
  it("calls baseCallbacks pass-through for all severities", () => {
    const base = { onLow: vi.fn(), onMedium: vi.fn(), onHigh: vi.fn() };
    const bridged = wrapRugMonitorCallbacks({ baseCallbacks: base, markForceExit: () => {} });
    bridged.onLow("MINT_A", "lp_movement", { evidence: {} });
    bridged.onMedium("MINT_A", "dev_sell", { evidence: {} });
    bridged.onHigh("MINT_A", "authority_change", { evidence: {} });
    expect(base.onLow).toHaveBeenCalledOnce();
    expect(base.onMedium).toHaveBeenCalledOnce();
    expect(base.onHigh).toHaveBeenCalledOnce();
  });

  it("does not crash if baseCallbacks missing", () => {
    const bridged = wrapRugMonitorCallbacks({ baseCallbacks: {}, markForceExit: () => {} });
    expect(() => bridged.onLow("X", "lp", {})).not.toThrow();
    expect(() => bridged.onHigh("X", "lp", {})).not.toThrow();
  });

  it("isolates base callback errors so bridge work still runs", () => {
    const base = { onHigh: () => { throw new Error("base broke"); } };
    const bridged = wrapRugMonitorCallbacks({ baseCallbacks: base, markForceExit: () => {} });
    expect(() => bridged.onHigh("MINT_X", "lp_movement", { evidence: {} })).not.toThrow();
  });
});

describe("RT1: realtime-intel-bridge — LP pattern accumulation", () => {
  it("triggers force-exit when slow-rug detector elevates from accumulated LP events", async () => {
    const marker = recordingMarker();
    const bridged = wrapRugMonitorCallbacks({
      baseCallbacks: {},
      markForceExit: marker.fn,
    });
    const mint = "MINT_SLOW";
    // Simulate 6 sequential LP events with progressively lower liquidity.
    // Each one alone is "small" (~8% drop), rug-monitor wouldn't fire HIGH,
    // but our slow-rug detector escalates to severity=high at 5+ removals
    // → bridge triggers force-exit even though no single event was urgent.
    const liqValues = [100_000, 92_000, 85_000, 78_000, 72_000, 66_000, 61_000];
    for (const lp of liqValues) {
      bridged.onLow(mint, "lp_movement", { evidence: { evt: { currentLp: lp } }, mint });
      await flush();
    }
    // Slow-rug should have triggered with HIGH severity
    const slowRug = evaluateSlowRug(mint);
    expect(slowRug.triggered).toBe(true);
    expect(slowRug.severity).toBe("high");
    // And marker should have been called at some point
    expect(marker.calls.length).toBeGreaterThan(0);
    expect(marker.calls[marker.calls.length - 1].reason).toMatch(/slow_rug_force_exit/);
  });

  it("does NOT force-exit on a single small LP movement", async () => {
    const marker = recordingMarker();
    const bridged = wrapRugMonitorCallbacks({
      baseCallbacks: {},
      markForceExit: marker.fn,
    });
    bridged.onLow("MINT_OK", "lp_movement", { evidence: { evt: { currentLp: 100_000 } }, mint: "MINT_OK" });
    await flush();
    bridged.onLow("MINT_OK", "lp_movement", { evidence: { evt: { currentLp: 96_000 } }, mint: "MINT_OK" });
    await flush();
    expect(marker.calls.length).toBe(0);
  });

  it("skips silently when LP evidence is missing currentLp", async () => {
    const marker = recordingMarker();
    const bridged = wrapRugMonitorCallbacks({
      baseCallbacks: {},
      markForceExit: marker.fn,
    });
    expect(() => bridged.onLow("X", "lp_movement", { evidence: {} })).not.toThrow();
    await flush();
    expect(marker.calls.length).toBe(0);
  });
});

describe("RT1: realtime-intel-bridge — dev wallet pattern accumulation", () => {
  it("triggers force-exit on dev-empty event series", async () => {
    const marker = recordingMarker();
    const bridged = wrapRugMonitorCallbacks({
      baseCallbacks: {},
      markForceExit: marker.fn,
    });
    const mint = "MINT_DEV";
    const baseMeta = {
      mint,
      deployer_wallet: "DEV_X",
      total_supply: 1_000_000,
    };
    bridged.onLow(mint, "dev_sell", { ...baseMeta, evidence: { current: 150_000 } });
    await flush();
    bridged.onMedium(mint, "dev_sell", { ...baseMeta, evidence: { current: 50_000 } });
    await flush();
    bridged.onHigh(mint, "dev_sell", { ...baseMeta, evidence: { current: 100 } });
    await flush();
    const devAct = evaluateDevActivity(mint);
    expect(["DEV_EMPTIED", "DEV_SOLD_5PCT", "DEV_DUMPING"]).toContain(devAct.alert);
    expect(marker.calls.some((c) => /dev_sell_force_exit/.test(c.reason))).toBe(true);
  });

  it("skips dev event without deployer_wallet metadata", async () => {
    const marker = recordingMarker();
    const bridged = wrapRugMonitorCallbacks({
      baseCallbacks: {},
      markForceExit: marker.fn,
    });
    bridged.onLow("MINT_NO_DEV", "dev_sell", {
      mint: "MINT_NO_DEV",
      total_supply: 1_000_000,
      evidence: { current: 1000 },
      // intentionally missing deployer_wallet
    });
    await flush();
    expect(marker.calls.length).toBe(0);
  });
});

describe("RT1: realtime-intel-bridge — mint extraction from position key", () => {
  it("extracts mint from 'mint:wallet' key form", async () => {
    const marker = recordingMarker();
    const bridged = wrapRugMonitorCallbacks({
      baseCallbacks: {},
      markForceExit: marker.fn,
    });
    // Position key has wallet suffix; meta.mint missing — bridge should derive
    const positionKey = "MINT_COMPOSITE:WALLET_ABC";
    bridged.onLow(positionKey, "lp_movement", { evidence: { evt: { currentLp: 50_000 } } });
    await flush();
    // No force exit yet (single event) but no crash either
    expect(marker.calls.length).toBe(0);
  });
});

describe("RT1: realtime-intel-bridge — routing", () => {
  it("routes lp signalType to LP handler only", async () => {
    const marker = recordingMarker();
    const bridged = wrapRugMonitorCallbacks({
      baseCallbacks: {},
      markForceExit: marker.fn,
    });
    // authority_change shouldn't trip dev or LP handlers
    bridged.onHigh("MINT_A", "authority_change", { mint: "MINT_A", evidence: { current: {} } });
    await flush();
    expect(marker.calls.length).toBe(0);
  });

  it("routes dev signalType to dev handler only", async () => {
    const recL = vi.fn();
    const recD = vi.fn();
    const bridged = wrapRugMonitorCallbacks({
      baseCallbacks: {},
      markForceExit: () => {},
      deps: {
        recordLiquiditySample: async (...a) => recL(...a),
        recordDevSnapshot: async (...a) => recD(...a),
        evaluateSlowRug: () => ({ triggered: false, severity: "none" }),
        evaluateDevActivity: () => ({ severity: "none", alert: "none" }),
      },
    });
    bridged.onLow("MINT_A", "dev_sell", {
      mint: "MINT_A",
      deployer_wallet: "DEV_X",
      total_supply: 1_000_000,
      evidence: { current: 1000 },
    });
    await flush();
    expect(recD).toHaveBeenCalled();
    expect(recL).not.toHaveBeenCalled();
  });
});
