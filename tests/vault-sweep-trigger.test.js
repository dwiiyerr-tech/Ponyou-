import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setVaultStateFile,
  isVaultDue,
  computeVaultAmount,
  getVaultSweepConfig,
} from "../vault.js";
import { config } from "../config.js";

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ponyou-vault-trigger-"));
  _setVaultStateFile(path.join(tempDir, "vault-state.json"));
  config.vault = {
    sweep: {
      enabled: true,
      sweepPct: 35,
      sweepIntervalDays: 7,
      minSweepSol: 0.001,
      vaultWallet: "TestWallet111",
    },
  };
  config.management = { gasReserve: 0.2 };
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("isVaultDue", () => {
  it("returns first_vault=true when no prior vault date", () => {
    const result = isVaultDue();
    expect(result.first_vault).toBe(true);
    expect(result.due).toBe(false);
  });

  it("returns due=false when last vault was 2 days ago (< 7 day interval)", () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(tempDir, "vault-state.json"),
      JSON.stringify({ lastVaultDate: recentDate, lastVaultTx: null, totalVaultedSol: 0, totalVaultedUsd: 0, vaultHistory: [] }),
    );
    const result = isVaultDue();
    expect(result.due).toBe(false);
    expect(result.days_remaining).toBeGreaterThan(0);
  });

  it("returns due=true when last vault was 8 days ago (> 7 day interval)", () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(tempDir, "vault-state.json"),
      JSON.stringify({ lastVaultDate: oldDate, lastVaultTx: "txabc", totalVaultedSol: 0.5, totalVaultedUsd: 50, vaultHistory: [] }),
    );
    const result = isVaultDue();
    expect(result.due).toBe(true);
    expect(result.days_remaining).toBe(0);
  });

  it("returns disabled=true when vault sweep disabled", () => {
    const result = isVaultDue({ enabled: false });
    expect(result.due).toBe(false);
    expect(result.disabled).toBe(true);
  });
});

describe("computeVaultAmount", () => {
  it("returns amount_sol=0 reason=vault_sweep_disabled when disabled", () => {
    const result = computeVaultAmount(1.5, { enabled: false });
    expect(result.amount_sol).toBe(0);
    expect(result.reason).toBe("vault_sweep_disabled");
    expect(result.enabled).toBe(false);
  });

  it("returns amount_sol=0 reason=below_min_sweep when too small", () => {
    // balance=0.2001, gasReserve=0.2, available=0.0001, 35% = 0.000035 < minSweepSol 0.001
    const result = computeVaultAmount(0.2001, { enabled: true, sweepPct: 35, minSweepSol: 0.001, sweepIntervalDays: 7 });
    expect(result.amount_sol).toBe(0);
    expect(result.reason).toBe("below_min_sweep");
  });

  it("returns correct amount_sol when balance sufficient", () => {
    // balance=1.2, gasReserve=0.2, available=1.0, 35% = 0.35 SOL
    const result = computeVaultAmount(1.2, { enabled: true, sweepPct: 35, minSweepSol: 0.001, sweepIntervalDays: 7 });
    expect(result.amount_sol).toBeCloseTo(0.35, 5);
    expect(result.enabled).toBe(true);
  });
});

describe("getVaultSweepConfig", () => {
  it("respects enabled=false override", () => {
    const cfg = getVaultSweepConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
  });

  it("respects sweepPct=50 override", () => {
    const cfg = getVaultSweepConfig({ sweepPct: 50 });
    expect(cfg.sweepPct).toBe(50);
  });

  it("clamps sweepPct to max 100", () => {
    const cfg = getVaultSweepConfig({ sweepPct: 150 });
    expect(cfg.sweepPct).toBe(100);
  });

  it("uses default sweepPct=35 from config when not overridden", () => {
    const cfg = getVaultSweepConfig({});
    expect(cfg.sweepPct).toBe(35);
  });
});
