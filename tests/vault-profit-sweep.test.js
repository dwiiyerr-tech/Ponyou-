import { describe, expect, it } from "vitest";
import { buildVaultConfig } from "../config.js";
import { computeProfitSweepAmount, getVaultSweepConfig } from "../vault-profit-sweep.js";
import { executeVaultTransfer } from "../vault.js";

describe("buildVaultConfig", () => {
  it("keeps legacy flat vault settings compatible", () => {
    const result = buildVaultConfig({
      vaultWallet: "LegacyVault1111111111111111111111111111111",
      vaultPct: 40,
      vaultIntervalDays: 3,
    }, {});

    expect(result.walletAddress).toBe("LegacyVault1111111111111111111111111111111");
    expect(result.pct).toBe(40);
    expect(result.intervalDays).toBe(3);
    expect(result.minSweepSol).toBe(0.001);
    expect(result.sweep).toMatchObject({
      enabled: true,
      sweepPct: 40,
      sweepIntervalDays: 3,
      minSweepSol: 0.001,
      vaultWallet: "LegacyVault1111111111111111111111111111111",
    });
  });

  it("accepts the nested vault.sweep config shape", () => {
    const result = buildVaultConfig({
      vault: {
        sweep: {
          enabled: false,
          vaultWallet: "NestedVault111111111111111111111111111111",
          sweepPct: 25,
          sweepIntervalDays: 2,
          minSweepSol: 0.05,
        },
      },
    }, {});

    expect(result.enabled).toBe(false);
    expect(result.walletAddress).toBe("NestedVault111111111111111111111111111111");
    expect(result.sweep).toMatchObject({
      enabled: false,
      sweepPct: 25,
      sweepIntervalDays: 2,
      minSweepSol: 0.05,
    });
  });
});

describe("computeProfitSweepAmount", () => {
  it("moves 35% of profit by default", () => {
    const result = computeProfitSweepAmount(100, 20);
    expect(result.amount_usd).toBe(35);
    expect(result.amount_sol).toBeCloseTo(1.75);
    expect(result.pct).toBe(35);
  });

  it("returns zero when inputs are invalid", () => {
    expect(computeProfitSweepAmount(0, 20).amount_sol).toBe(0);
    expect(computeProfitSweepAmount(10, 0).amount_sol).toBe(0);
  });

  it("honors configurable sweep pct and minimum sweep size", () => {
    const result = computeProfitSweepAmount(100, 20, {
      sweepPct: 25,
      minSweepSol: 0.5,
    });

    expect(result.amount_usd).toBe(25);
    expect(result.amount_sol).toBeCloseTo(1.25);
    expect(result.min_sweep_sol).toBe(0.5);
  });

  it("blocks dust sweeps below minSweepSol", () => {
    const result = computeProfitSweepAmount(10, 100, {
      sweepPct: 20,
      minSweepSol: 0.05,
    });

    expect(result).toMatchObject({
      amount_sol: 0,
      amount_usd: 0,
      raw_amount_sol: 0.02,
      raw_amount_usd: 2,
      reason: "below_min_sweep",
    });
  });

  it("returns zero when the sweep toggle is disabled", () => {
    const result = computeProfitSweepAmount(100, 20, { enabled: false });
    expect(result).toMatchObject({
      amount_sol: 0,
      amount_usd: 0,
      enabled: false,
      reason: "vault_sweep_disabled",
    });
  });
});

describe("vault sweep execution gates", () => {
  it("refuses disabled sweeps before wallet or network checks", async () => {
    const result = await executeVaultTransfer(1, 100, { enabled: false });
    expect(result).toMatchObject({
      success: false,
      disabled: true,
      error: "Vault sweep disabled",
    });
  });

  it("normalizes runtime override config", () => {
    const cfg = getVaultSweepConfig({
      enabled: true,
      vaultWallet: "RuntimeVault11111111111111111111111111111",
      sweepPct: 12,
      sweepIntervalDays: 4,
      minSweepSol: 0.02,
    });

    expect(cfg).toEqual({
      enabled: true,
      vaultWallet: "RuntimeVault11111111111111111111111111111",
      sweepPct: 12,
      sweepIntervalDays: 4,
      minSweepSol: 0.02,
    });
  });
});
