import { describe, it, expect } from "vitest";
import {
  buildVaultConfig,
  buildRugMonitorConfig,
  buildExecutionEdgeConfig,
  config,
} from "../config.js";

describe("config — buildVaultConfig", () => {
  it("returns defaults with empty input", () => {
    const v = buildVaultConfig({});
    expect(v.enabled).toBe(true);
    expect(v.pct).toBe(35);
    expect(v.intervalDays).toBe(7);
    expect(v.minSweepSol).toBe(0.001);
    expect(v.walletAddress).toBeNull();
    expect(v.sweep.sweepPct).toBe(35);
  });

  it("reads wallet from vault.walletAddress", () => {
    const v = buildVaultConfig({ vault: { walletAddress: "WALL" } });
    expect(v.walletAddress).toBe("WALL");
  });

  it("reads wallet from sweep.vaultWallet", () => {
    const v = buildVaultConfig({ vault: { sweep: { vaultWallet: "SWEEPWALL" } } });
    expect(v.walletAddress).toBe("SWEEPWALL");
  });

  it("bounds sweepPct between 0 and 100", () => {
    const v = buildVaultConfig({ vault: { sweep: { pct: 150 } } });
    expect(v.pct).toBe(100);
  });

  it("disabled when vault.enabled is false", () => {
    const v = buildVaultConfig({ vault: { enabled: false } });
    expect(v.enabled).toBe(false);
  });

  it("respects custom interval", () => {
    const v = buildVaultConfig({ vault: { sweep: { intervalDays: 3 } } });
    expect(v.intervalDays).toBe(3);
  });

  it("reads from top-level sweepPct key", () => {
    const v = buildVaultConfig({ sweepPct: 42 });
    expect(v.pct).toBe(42);
  });
});

describe("config — buildRugMonitorConfig", () => {
  it("returns sensible defaults", () => {
    const rm = buildRugMonitorConfig({});
    expect(rm.enabled).toBe(true);
    expect(rm.pollingIntervalSec).toBe(30);
    expect(rm.rateLimitLowSec).toBe(60);
    expect(rm.actions.high.type).toBe("sell_all");
    expect(rm.actions.medium.type).toBe("sell_partial");
  });

  it("merges custom thresholds", () => {
    const rm = buildRugMonitorConfig({
      rugMonitor: {
        devSellThresholds: { low: -10, medium: -30, high: -80 },
        pollingIntervalSec: 15,
      },
    });
    expect(rm.devSellThresholds.low).toBe(-10);
    expect(rm.devSellThresholds.high).toBe(-80);
    expect(rm.pollingIntervalSec).toBe(15);
  });
});

describe("config — buildExecutionEdgeConfig", () => {
  it("returns defaults with empty input", () => {
    const ee = buildExecutionEdgeConfig({});
    expect(ee.enabled).toBe(true);
    expect(ee.rpcEndpoints.length).toBeGreaterThan(1);
    expect(ee.executor.maxAttempts).toBe(5);
    expect(ee.executor.defaultCuLimit).toBe(200_000);
  });

  it("uses custom RPC endpoints", () => {
    const ee = buildExecutionEdgeConfig({
      executionEdge: { rpcEndpoints: [{ url: "https://custom.rpc" }] },
    });
    expect(ee.rpcEndpoints).toHaveLength(1);
    expect(ee.rpcEndpoints[0].url).toBe("https://custom.rpc");
  });

  it("respects custom fee oracle settings", () => {
    const ee = buildExecutionEdgeConfig({
      executionEdge: { feeOracle: { maxTipLamports: 1000, cacheStaleMs: 5000 } },
    });
    expect(ee.feeOracle.maxTipLamports).toBe(1000);
    expect(ee.feeOracle.cacheStaleMs).toBe(5000);
  });
});

describe("config — main config object", () => {
  it("has expected top-level keys", () => {
    expect(config.llm).toBeDefined();
    expect(config.pilot).toBeDefined();
    expect(config.risk).toBeDefined();
  });

  it("llm config has required fields", () => {
    expect(config.llm.maxSteps).toBeGreaterThan(0);
    expect(config.llm.maxTokens).toBeGreaterThan(0);
    expect(typeof config.llm.temperature).toBe("number");
  });
});
