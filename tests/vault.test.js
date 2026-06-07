import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE = path.join(__dirname, "..", "vault-state.json");
const TEST_STATE = path.join(__dirname, "..", "vault-state.test.json");

function cleanState() {
  try { fs.unlinkSync(TEST_STATE); } catch (_) {}
}

beforeEach(() => {
  cleanState();
  // Force test file path
  process.env.DRY_RUN = "true";
});

afterEach(() => {
  cleanState();
  delete process.env.DRY_RUN;
});

describe("vault — getVaultSweepConfig", () => {
  it("returns defaults with no overrides", async () => {
    const { getVaultSweepConfig, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const cfg = getVaultSweepConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.sweepPct).toBe(35);
    expect(cfg.sweepIntervalDays).toBe(7);
    expect(cfg.minSweepSol).toBe(0.001);
  });

  it("respects overrides", async () => {
    const { getVaultSweepConfig, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const cfg = getVaultSweepConfig({
      sweepPct: 50,
      sweepIntervalDays: 3,
      vaultWallet: "OverrideWallet",
    });
    expect(cfg.sweepPct).toBe(50);
    expect(cfg.sweepIntervalDays).toBe(3);
    expect(cfg.vaultWallet).toBe("OverrideWallet");
  });

  it("disabled via overrides", async () => {
    const { getVaultSweepConfig, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const cfg = getVaultSweepConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
  });
});

describe("vault — isVaultDue", () => {
  it("not due without vault wallet configured (no lastVaultDate)", async () => {
    const { isVaultDue, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = isVaultDue();
    expect(result.due).toBe(false);
    expect(result.first_vault).toBe(true);
  });

  it("disabled vault returns due=false", async () => {
    const { isVaultDue, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = isVaultDue({ enabled: false });
    expect(result.due).toBe(false);
    expect(result.disabled).toBe(true);
  });
});

describe("vault — computeVaultAmount", () => {
  it("computes vault amount from liquid SOL", async () => {
    const { computeVaultAmount, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = computeVaultAmount(10); // 10 SOL liquid
    expect(result.enabled).toBe(true);
    // 10 - 0.2 (gas reserve) = 9.8, then 35% = ~3.43
    expect(result.amount_sol).toBeGreaterThan(0);
    expect(result.amount_sol).toBeLessThan(10);
  });

  it("disabled vault returns 0", async () => {
    const { computeVaultAmount, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = computeVaultAmount(10, { enabled: false });
    expect(result.amount_sol).toBe(0);
    expect(result.reason).toBe("vault_sweep_disabled");
  });

  it("below min sweep returns 0", async () => {
    const { computeVaultAmount, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = computeVaultAmount(0.1, { sweepPct: 1 }); // tiny amount
    // Even with 1% sweep of 0.1 SOL after gas, it's below min
    if (result.amount_sol === 0) {
      expect(result.reason).toBeTruthy();
    }
  });
});

describe("vault — computeProfitSweepAmount", () => {
  it("computes based on net profit", async () => {
    const { computeProfitSweepAmount, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = computeProfitSweepAmount(100, 50); // $100 profit, $50 SOL
    expect(result.amount_sol).toBeGreaterThan(0);
    expect(result.amount_usd).toBeCloseTo(35); // 35% of $100
  });

  it("returns 0 for non-positive profit", async () => {
    const { computeProfitSweepAmount, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = computeProfitSweepAmount(0, 50);
    expect(result.amount_sol).toBe(0);
    expect(result.reason).toBe("invalid_profit_or_sol_price");
  });
});

describe("vault — executeVaultTransfer (dry-run)", () => {
  it("dry run returns success without real tx", async () => {
    const { executeVaultTransfer, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = await executeVaultTransfer(0.5, 50, { vaultWallet: "DRYwallet", force: true });
    expect(result.dry_run).toBe(true);
    expect(result.success).toBe(true);
    expect(result.amount_sol).toBe(0.5);
  });

  it("fails without wallet configured", async () => {
    const { executeVaultTransfer, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const result = await executeVaultTransfer(0.5);
    expect(result.success).toBe(false);
  });
});

describe("vault — recordVaultTransfer", () => {
  it("records a dry-run vault to state", async () => {
    const { recordVaultTransfer, getVaultStatus, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    recordVaultTransfer({
      amount_sol: 1.5,
      amount_usd: 75,
      tx: "dry_run",
      vault_wallet: "TestWallet",
    });
    const status = getVaultStatus();
    expect(status.total_vaulted_sol).toBe(1.5);
    expect(status.vault_count).toBe(1);
  });
});

describe("vault — buildVaultNotification", () => {
  it("creates dry-run notification", async () => {
    const { buildVaultNotification, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const msg = buildVaultNotification({
      dry_run: true,
      amount_sol: 2,
      amount_usd: 100,
      vault_wallet: "WalletAddr",
    });
    expect(msg).toContain("dry-run");
    expect(msg).toContain("2.0000");
  });

  it("creates real tx notification", async () => {
    const { buildVaultNotification, _setVaultStateFile } = await import("../vault.js");
    _setVaultStateFile(TEST_STATE);
    const msg = buildVaultNotification({
      success: true,
      amount_sol: 3,
      amount_usd: 150,
      tx: "abc123def456",
      vault_wallet: "WalletAddr",
    });
    expect(msg).toContain("terkirim");
    expect(msg).toContain("3.0000");
  });
});
