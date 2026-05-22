/**
 * Vault — Sistem Tabungan Otomatis.
 *
 * Setiap N hari, kirim persentase profit/saldo SOL trading ke wallet vault.
 * Tujuan: pisahkan profit dari modal trading, hindari over-trading.
 *
 * Konfigurasi:
 *   vault.sweep.enabled — on/off sweep gate
 *   vault.sweep.vaultWallet — alamat Solana tujuan (user-config.json atau .env)
 *   vault.sweep.sweepPct — persentase yang dikirim (default 35%)
 *   vault.sweep.sweepIntervalDays — interval hari (default 7)
 *   vault.sweep.minSweepSol — minimum transfer (default 0.001 SOL)
 *
 * Cara kerja:
 *   1. Cek apakah sudah 7 hari sejak vault terakhir
 *   2. Hitung 35% dari saldo liquid SOL (setelah gas reserve)
 *   3. Kirim via SystemProgram.transfer (SOL native)
 *   4. Catat di vault-state.json dan notifikasi Telegram
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { Connection, PublicKey, SystemProgram, Transaction, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let VAULT_STATE_FILE = path.join(__dirname, "vault-state.json");

export function _setVaultStateFile(filePath) {
  VAULT_STATE_FILE = filePath;
}

// ─── State ─────────────────────────────────────────────────────

const EMPTY_VAULT_STATE = () => ({
  lastVaultDate: null,
  lastVaultTx: null,
  totalVaultedSol: 0,
  totalVaultedUsd: 0,
  vaultHistory: [],
});

function loadVaultState() {
  if (!fs.existsSync(VAULT_STATE_FILE)) return EMPTY_VAULT_STATE();
  try {
    const data = JSON.parse(fs.readFileSync(VAULT_STATE_FILE, "utf8"));
    // Fill in any missing fields so downstream callers don't see `undefined`.
    return { ...EMPTY_VAULT_STATE(), ...data };
  } catch {
    return EMPTY_VAULT_STATE();
  }
}

function saveVaultState(state) {
  state.lastUpdated = new Date().toISOString();
  atomicWriteJson(VAULT_STATE_FILE, state);
}

// ─── Config helpers ────────────────────────────────────────────

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const number = finiteNumber(value, fallback);
  return Math.min(max, Math.max(min, number));
}

function boolValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function getVaultSweepConfig(overrides = {}) {
  const vault = config.vault || {};
  const sweep = vault.sweep || {};
  const enabled = boolValue(
    overrides.enabled ?? sweep.enabled ?? vault.enabled,
    true,
  );
  const vaultWallet = nonEmptyString(
    overrides.vaultWallet,
    process.env.VAULT_WALLET,
    sweep.vaultWallet,
    vault.vaultWallet,
    vault.walletAddress,
  );
  const sweepPct = boundedNumber(
    overrides.sweepPct ?? overrides.pct ?? sweep.sweepPct ?? sweep.pct ?? vault.sweepPct ?? vault.pct,
    35,
    0,
    100,
  );
  const sweepIntervalDays = Math.max(1, finiteNumber(
    overrides.sweepIntervalDays ?? overrides.intervalDays ?? sweep.sweepIntervalDays ?? sweep.intervalDays ?? vault.sweepIntervalDays ?? vault.intervalDays,
    7,
  ));
  const minSweepSol = Math.max(0, finiteNumber(
    overrides.minSweepSol ?? sweep.minSweepSol ?? vault.minSweepSol,
    0.001,
  ));

  return {
    enabled,
    vaultWallet,
    sweepPct,
    sweepIntervalDays,
    minSweepSol,
  };
}

function getVaultWallet(overrides = {}) {
  return getVaultSweepConfig(overrides).vaultWallet;
}

function getVaultPct(overrides = {}) {
  return getVaultSweepConfig(overrides).sweepPct;
}

function getVaultIntervalDays(overrides = {}) {
  return getVaultSweepConfig(overrides).sweepIntervalDays;
}

function getMinSweepSol(overrides = {}) {
  return getVaultSweepConfig(overrides).minSweepSol;
}

function zeroSweepResult(cfg, reason, extra = {}) {
  return {
    amount_sol: 0,
    amount_usd: 0,
    pct: cfg.sweepPct,
    enabled: cfg.enabled,
    min_sweep_sol: cfg.minSweepSol,
    reason,
    ...extra,
  };
}

// ─── Core Logic ────────────────────────────────────────────────

/**
 * Cek apakah sudah waktunya vault.
 * @returns {{ due: boolean, days_since_last: number, days_remaining: number }}
 */
export function isVaultDue(overrides = {}) {
  const state = loadVaultState();
  const cfg = getVaultSweepConfig(overrides);
  const intervalDays = cfg.sweepIntervalDays;

  if (!cfg.enabled) {
    return { due: false, disabled: true, days_since_last: 0, days_remaining: intervalDays, first_vault: false };
  }

  if (!state.lastVaultDate) {
    return { due: false, days_since_last: 0, days_remaining: intervalDays, first_vault: true };
  }

  const daysSince = (Date.now() - new Date(state.lastVaultDate).getTime()) / (1000 * 60 * 60 * 24);
  const remaining = Math.max(0, intervalDays - daysSince);

  return {
    due: daysSince >= intervalDays,
    days_since_last: parseFloat(daysSince.toFixed(1)),
    days_remaining: parseFloat(remaining.toFixed(1)),
  };
}

/**
 * Hitung berapa SOL yang akan di-vault.
 * @param {number} liquidSol — SOL liquid (tidak termasuk gas reserve)
 * @returns {{ amount_sol: number, pct: number }}
 */
export function computeVaultAmount(liquidSol, overrides = {}) {
  const cfg = getVaultSweepConfig(overrides);
  if (!cfg.enabled) {
    return {
      amount_sol: 0,
      pct: cfg.sweepPct,
      available_sol: 0,
      enabled: false,
      min_sweep_sol: cfg.minSweepSol,
      reason: "vault_sweep_disabled",
    };
  }
  const pct = cfg.sweepPct;
  const gasReserve = config.management?.gasReserve ?? 0.2;
  const available = Math.max(0, liquidSol - gasReserve);
  const vaultSol = parseFloat((available * pct / 100).toFixed(6));
  if (vaultSol < cfg.minSweepSol) {
    return {
      amount_sol: 0,
      pct,
      available_sol: available,
      raw_amount_sol: vaultSol,
      enabled: true,
      min_sweep_sol: cfg.minSweepSol,
      reason: "below_min_sweep",
    };
  }
  return { amount_sol: vaultSol, pct, available_sol: available, enabled: true, min_sweep_sol: cfg.minSweepSol };
}

export function computeProfitSweepAmount(netProfitUsd, solPriceUsd = 0, overrides = {}) {
  const cfg = getVaultSweepConfig(overrides);
  if (!cfg.enabled) {
    return zeroSweepResult(cfg, "vault_sweep_disabled");
  }
  if (!(netProfitUsd > 0) || !(solPriceUsd > 0)) {
    return zeroSweepResult(cfg, "invalid_profit_or_sol_price");
  }
  const pct = cfg.sweepPct;
  const amountUsd = netProfitUsd * pct / 100;
  const amountSol = amountUsd / solPriceUsd;
  const roundedSol = parseFloat(amountSol.toFixed(6));
  const roundedUsd = parseFloat(amountUsd.toFixed(2));
  if (roundedSol < cfg.minSweepSol) {
    return zeroSweepResult(cfg, "below_min_sweep", {
      raw_amount_sol: roundedSol,
      raw_amount_usd: roundedUsd,
    });
  }
  return {
    amount_sol: roundedSol,
    amount_usd: roundedUsd,
    pct,
    enabled: true,
    min_sweep_sol: cfg.minSweepSol,
  };
}

/**
 * Transfer SOL ke vault wallet.
 * @param {number} amountSol — jumlah SOL yang dikirim
 * @param {number} solPriceUsd — harga SOL untuk estimasi USD
 * @returns {Promise<{ success: boolean, tx?: string, amount_sol: number, amount_usd: number }>}
 */
export async function executeVaultTransfer(amountSol, solPriceUsd = 0, overrides = {}) {
  const cfg = getVaultSweepConfig(overrides);
  const vaultWallet = cfg.vaultWallet;

  if (!cfg.enabled) {
    return { success: false, disabled: true, error: "Vault sweep disabled" };
  }

  if (!vaultWallet) {
    return { success: false, error: "VAULT_WALLET tidak dikonfigurasi. Set di .env atau user-config.json." };
  }

  const amount = Number(amountSol);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: `Jumlah tidak valid: ${amountSol} SOL` };
  }

  if (amount < cfg.minSweepSol) {
    return { success: false, error: `Jumlah terlalu kecil: ${amount} SOL (minimum ${cfg.minSweepSol} SOL)` };
  }

  if (process.env.DRY_RUN === "true") {
    const estUsd = amount * solPriceUsd;
    log("vault", `DRY RUN — vault ${amount} SOL (~$${estUsd.toFixed(2)}) → ${vaultWallet}`);
    return {
      dry_run: true,
      success: true,
      amount_sol: amount,
      amount_usd: estUsd,
      vault_wallet: vaultWallet,
      message: "DRY RUN — tidak ada transaksi nyata",
    };
  }

  try {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY tidak di-set");

    const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    const connection = new Connection(
      process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed",
    );

    let vaultPubkey;
    try {
      vaultPubkey = new PublicKey(vaultWallet);
    } catch {
      throw new Error(`Alamat vault tidak valid: ${vaultWallet}`);
    }

    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: vaultPubkey,
        lamports,
      })
    );

    const sig = await sendAndConfirmTransaction(connection, transaction, [wallet]);
    const amountUsd = amount * solPriceUsd;

    log("vault", `VAULT TRANSFER SUKSES: ${amount} SOL (~$${amountUsd.toFixed(2)}) → ${vaultWallet} | tx: ${sig}`);

    // Simpan ke state
    const vaultState = loadVaultState();
    vaultState.lastVaultDate = new Date().toISOString();
    vaultState.lastVaultTx = sig;
    vaultState.totalVaultedSol = parseFloat(((vaultState.totalVaultedSol || 0) + amount).toFixed(6));
    vaultState.totalVaultedUsd = parseFloat(((vaultState.totalVaultedUsd || 0) + amountUsd).toFixed(2));
    vaultState.vaultHistory.push({
      ts: new Date().toISOString(),
      amount_sol: amount,
      amount_usd: parseFloat(amountUsd.toFixed(2)),
      tx: sig,
      vault_wallet: vaultWallet,
    });
    if (vaultState.vaultHistory.length > 52) vaultState.vaultHistory = vaultState.vaultHistory.slice(-52);
    saveVaultState(vaultState);

    return {
      success: true,
      tx: sig,
      amount_sol: amount,
      amount_usd: parseFloat(amountUsd.toFixed(2)),
      vault_wallet: vaultWallet,
    };
  } catch (error) {
    log("vault_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Record vault yang dilakukan setelah sukses (untuk DRY RUN atau manual).
 */
export function recordVaultTransfer({ amount_sol, amount_usd, tx, vault_wallet }) {
  const vaultState = loadVaultState();
  vaultState.lastVaultDate = new Date().toISOString();
  vaultState.lastVaultTx = tx || "dry_run";
  vaultState.totalVaultedSol = parseFloat(((vaultState.totalVaultedSol || 0) + (amount_sol || 0)).toFixed(6));
  vaultState.totalVaultedUsd = parseFloat(((vaultState.totalVaultedUsd || 0) + (amount_usd || 0)).toFixed(2));
  vaultState.vaultHistory.push({
    ts: new Date().toISOString(),
    amount_sol: amount_sol || 0,
    amount_usd: amount_usd || 0,
    tx: tx || "dry_run",
    vault_wallet: vault_wallet || getVaultWallet(),
  });
  if (vaultState.vaultHistory.length > 52) vaultState.vaultHistory = vaultState.vaultHistory.slice(-52);
  saveVaultState(vaultState);
}

/**
 * Ambil status vault untuk laporan dan prompt.
 */
export function getVaultStatus() {
  const state = loadVaultState();
  const cfg = getVaultSweepConfig();
  const due = isVaultDue();
  const vaultWallet = cfg.vaultWallet;

  return {
    enabled: cfg.enabled,
    configured: cfg.enabled && !!vaultWallet,
    vault_wallet: vaultWallet ? `${vaultWallet.slice(0, 8)}...${vaultWallet.slice(-4)}` : null,
    vault_pct: getVaultPct(),
    sweep_pct: cfg.sweepPct,
    interval_days: getVaultIntervalDays(),
    sweep_interval_days: cfg.sweepIntervalDays,
    min_sweep_sol: getMinSweepSol(),
    last_vault_date: state.lastVaultDate,
    last_tx: state.lastVaultTx,
    total_vaulted_sol: state.totalVaultedSol,
    total_vaulted_usd: state.totalVaultedUsd,
    vault_count: state.vaultHistory.length,
    days_until_next: due.days_remaining,
    is_due: due.due,
    recent_history: state.vaultHistory.slice(-3),
  };
}

/**
 * Buat pesan Telegram yang informatif setelah vault berhasil.
 */
function htmlEscape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildVaultNotification(result) {
  const state = loadVaultState();
  const vaultStatus = getVaultStatus();
  const amount = Number(result.amount_sol) || 0;
  const usd = Number(result.amount_usd) || 0;
  const target = result.vault_wallet || "";
  const targetShort = target ? `${target.slice(0, 8)}…${target.slice(-4)}` : "?";

  if (result.dry_run) {
    return [
      `🏦 <b>Vault</b> · <i>dry-run</i>`,
      `${amount.toFixed(4)} SOL (≈ $${usd.toFixed(2)})`,
      `→ <code>${htmlEscape(targetShort)}</code>`,
      `Total: ${vaultStatus.total_vaulted_sol} SOL · next ${vaultStatus.interval_days}d`,
    ].join("\n");
  }

  const tx = result.tx ? `${result.tx.slice(0, 8)}…` : "?";
  return [
    `🏦 <b>Vault terkirim</b>`,
    `${amount.toFixed(4)} SOL (≈ $${usd.toFixed(2)}) → <code>${htmlEscape(targetShort)}</code>`,
    `Tx: <code>${htmlEscape(tx)}</code>`,
    `Total: ${state.totalVaultedSol} SOL ($${state.totalVaultedUsd}) · #${state.vaultHistory.length}`,
  ].join("\n");
}
