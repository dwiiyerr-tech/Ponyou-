/**
 * Vault — Sistem Tabungan Otomatis.
 *
 * Setiap 7 hari, kirim 35% dari saldo SOL trading ke wallet vault.
 * Tujuan: pisahkan profit dari modal trading, hindari over-trading.
 *
 * Konfigurasi:
 *   vaultWallet     — alamat Solana tujuan (user-config.json atau .env)
 *   vaultPct        — persentase yang dikirim (default 35%)
 *   vaultIntervalDays — interval hari (default 7)
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
import { Connection, PublicKey, SystemProgram, Transaction, Keypair, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_STATE_FILE = path.join(__dirname, "vault-state.json");

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
  fs.writeFileSync(VAULT_STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Config helpers ────────────────────────────────────────────

function getVaultWallet() {
  return process.env.VAULT_WALLET || config.vault?.walletAddress || null;
}

function getVaultPct() {
  return config.vault?.pct ?? 35;
}

function getVaultIntervalDays() {
  return config.vault?.intervalDays ?? 7;
}

// ─── Core Logic ────────────────────────────────────────────────

/**
 * Cek apakah sudah waktunya vault.
 * @returns {{ due: boolean, days_since_last: number, days_remaining: number }}
 */
export function isVaultDue() {
  const state = loadVaultState();
  const intervalDays = getVaultIntervalDays();

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
export function computeVaultAmount(liquidSol) {
  const pct = getVaultPct();
  const gasReserve = config.management?.gasReserve ?? 0.2;
  const available = Math.max(0, liquidSol - gasReserve);
  const vaultSol = parseFloat((available * pct / 100).toFixed(6));
  return { amount_sol: vaultSol, pct, available_sol: available };
}

/**
 * Transfer SOL ke vault wallet.
 * @param {number} amountSol — jumlah SOL yang dikirim
 * @param {number} solPriceUsd — harga SOL untuk estimasi USD
 * @returns {Promise<{ success: boolean, tx?: string, amount_sol: number, amount_usd: number }>}
 */
export async function executeVaultTransfer(amountSol, solPriceUsd = 0) {
  const vaultWallet = getVaultWallet();

  if (!vaultWallet) {
    return { success: false, error: "VAULT_WALLET tidak dikonfigurasi. Set di .env atau user-config.json." };
  }

  if (amountSol < 0.001) {
    return { success: false, error: `Jumlah terlalu kecil: ${amountSol} SOL (minimum 0.001 SOL)` };
  }

  if (process.env.DRY_RUN === "true") {
    const estUsd = amountSol * solPriceUsd;
    log("vault", `DRY RUN — vault ${amountSol} SOL (~$${estUsd.toFixed(2)}) → ${vaultWallet}`);
    return {
      dry_run: true,
      success: true,
      amount_sol: amountSol,
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

    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: vaultPubkey,
        lamports,
      })
    );

    const sig = await sendAndConfirmTransaction(connection, transaction, [wallet]);
    const amountUsd = amountSol * solPriceUsd;

    log("vault", `VAULT TRANSFER SUKSES: ${amountSol} SOL (~$${amountUsd.toFixed(2)}) → ${vaultWallet} | tx: ${sig}`);

    // Simpan ke state
    const vaultState = loadVaultState();
    vaultState.lastVaultDate = new Date().toISOString();
    vaultState.lastVaultTx = sig;
    vaultState.totalVaultedSol = parseFloat(((vaultState.totalVaultedSol || 0) + amountSol).toFixed(6));
    vaultState.totalVaultedUsd = parseFloat(((vaultState.totalVaultedUsd || 0) + amountUsd).toFixed(2));
    vaultState.vaultHistory.push({
      ts: new Date().toISOString(),
      amount_sol: amountSol,
      amount_usd: parseFloat(amountUsd.toFixed(2)),
      tx: sig,
      vault_wallet: vaultWallet,
    });
    if (vaultState.vaultHistory.length > 52) vaultState.vaultHistory = vaultState.vaultHistory.slice(-52);
    saveVaultState(vaultState);

    return {
      success: true,
      tx: sig,
      amount_sol: amountSol,
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
  const due = isVaultDue();
  const vaultWallet = getVaultWallet();

  return {
    configured: !!vaultWallet,
    vault_wallet: vaultWallet ? `${vaultWallet.slice(0, 8)}...${vaultWallet.slice(-4)}` : null,
    vault_pct: getVaultPct(),
    interval_days: getVaultIntervalDays(),
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
