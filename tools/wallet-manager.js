/**
 * Multi-wallet manager — Capital Splitting (A) + Hot/Cold Rotation (B)
 *
 * - Capital Splitting: tiap wallet mendapat porsi modal (capital_pct)
 * - Hot/Cold Rotation: wallet dengan error >= threshold → cold, rotasi ke next
 * - Backward-compatible: jika multiWallet.enabled=false, fallback ke
 *   WALLET_PRIVATE_KEY tunggal, semua existing call paths tidak berubah.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { recordCounter } from "../metrics.js";
import { config } from "../config.js";
import { analyzeCapitalAwareWalletPlan } from "../multi-wallet-allocation.js";
import { planWalletExecution } from "../wallet-strategy.js";
import { validateWalletTopology } from "../wallet-topology.js";

// status: 'hot' = aktif | 'cold' = cooldown | 'disabled' = manual off
const _wallets = new Map(); // address → { keypair, label, status, capital_pct, error_count, cold_until }
let _activeAddress = null;
let _recoveryInterval = null;

export function initWalletManager() {
  _wallets.clear();
  _activeAddress = null;
  if (_recoveryInterval) { clearInterval(_recoveryInterval); _recoveryInterval = null; }

  const mw = config.multiWallet;
  const topology = validateWalletTopology({ enabled: !!mw?.enabled, wallets: mw?.wallets || [] });

  if (mw?.enabled && !topology.ok) {
    const error = new Error(`Invalid multi-wallet topology: ${topology.errors.join(" ")}`);
    error.walletTopology = topology;
    throw error;
  }

  if (!mw?.enabled || !mw.wallets?.length) {
    // Single-wallet fallback — populate map supaya getActiveWallet() tetap konsisten
    const key = process.env.WALLET_PRIVATE_KEY;
    if (key) {
      try {
        const keypair = Keypair.fromSecretKey(bs58.decode(key));
        const address = keypair.publicKey.toString();
        _wallets.set(address, { keypair, label: "main", status: "hot", capital_pct: 100, error_count: 0, cold_until: 0 });
        _activeAddress = address;
        log("wallet_mgr", `Single-wallet mode: ${address.slice(0, 8)}…`);
      } catch (e) {
        log("wallet_mgr", `WALLET_PRIVATE_KEY invalid: ${e.message}`);
      }
    }
    return;
  }

  // Multi-wallet mode
  let totalPct = 0;
  for (const w of mw.wallets) {
    if (!w.key) continue;
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(w.key));
      const address = keypair.publicKey.toString();
      const pct = Number(w.capital_pct) || 0;
      totalPct += pct;
      _wallets.set(address, {
        keypair,
        label:       w.label || address.slice(0, 8),
        status:      "hot",
        capital_pct: pct,
        error_count: 0,
        cold_until:  0,
      });
      if (!_activeAddress) _activeAddress = address;
      log("wallet_mgr", `Wallet loaded: ${w.label || address.slice(0, 8)} (${pct}%)`);
    } catch (e) {
      log("wallet_mgr", `Wallet key invalid (${w.label || "?"}): ${e.message}`);
    }
  }

  if (Math.round(totalPct) !== 100) {
    log("wallet_mgr", `⚠️  capital_pct total = ${totalPct}% (bukan 100%) — sesuaikan wallets[] di user-config.json`);
  }

  // Background recovery: cek wallet cold yang sudah melewati cooldown
  _recoveryInterval = setInterval(_recoverColdWallets, 60_000);

  log("wallet_mgr", `Multi-wallet mode: ${_wallets.size} wallets, active = ${_activeAddress?.slice(0, 8)}…`);
}

/** Wallet aktif saat ini, atau null jika tidak ada yang terkonfigurasi */
export function getActiveWallet() {
  if (!_activeAddress) return null;
  const w = _wallets.get(_activeAddress);
  if (!w) return null;
  return { keypair: w.keypair, address: _activeAddress, label: w.label, capital_pct: w.capital_pct };
}

/** Semua wallet beserta status runtime */
export function getAllWallets() {
  return Array.from(_wallets.entries()).map(([address, w]) => ({
    address,
    label:       w.label,
    status:      w.status,
    capital_pct: w.capital_pct,
    error_count: w.error_count,
    cold_until:  w.cold_until,
    is_active:   address === _activeAddress,
  }));
}

export function getWalletByAddress(address) {
  const w = _wallets.get(address);
  if (!w) return null;
  return {
    keypair: w.keypair,
    address,
    label: w.label,
    capital_pct: w.capital_pct,
    status: w.status,
  };
}

/** Tandai wallet aktif sebagai cold lalu rotasi ke wallet hot berikutnya */
export function rotateWallet(reason = "") {
  if (!_activeAddress) return;
  const current = _wallets.get(_activeAddress);
  if (current) {
    current.status     = "cold";
    current.cold_until = Date.now() + (config.multiWallet?.rotationCooldownMs ?? 600_000);
    log("wallet_mgr", `Wallet ${current.label} → cold (${reason})`);
    recordCounter("wallet_rotate");
  }

  // Round-robin: cari next hot wallet
  const addresses = Array.from(_wallets.keys());
  const startIdx  = addresses.indexOf(_activeAddress);
  for (let i = 1; i <= addresses.length; i++) {
    const addr = addresses[(startIdx + i) % addresses.length];
    const w    = _wallets.get(addr);
    if (w && w.status === "hot") {
      _activeAddress = addr;
      log("wallet_mgr", `Active wallet → ${w.label} (${addr.slice(0, 8)}…)`);
      return;
    }
  }
  log("wallet_mgr", "⚠️  Tidak ada wallet hot tersisa — semua cold/disabled");
}

/** Catat error pada wallet. Jika >= threshold → rotasi otomatis */
export function markWalletError(address) {
  const w = _wallets.get(address);
  if (!w) return;
  w.error_count++;
  recordCounter("wallet_error");
  log("wallet_mgr", `Error #${w.error_count} on ${w.label}`);
  const threshold = config.multiWallet?.rotationMaxErrors ?? 3;
  if (isMultiWalletEnabled() && w.error_count >= threshold && address === _activeAddress) {
    rotateWallet(`max errors (${w.error_count}/${threshold}) on ${w.label}`);
  }
}

/** Reset error count, kembalikan wallet ke hot */
export function resetWalletErrors(address) {
  const w = _wallets.get(address);
  if (!w) return;
  w.error_count = 0;
  w.status      = "hot";
  w.cold_until  = 0;
  log("wallet_mgr", `Wallet ${w.label} errors reset → hot`);
}

/**
 * Hitung alokasi SOL untuk wallet berdasarkan capital_pct.
 * Single-wallet fallback: kembalikan totalSol apa adanya.
 */
export function getWalletCapitalSol(walletAddress, totalSol) {
  if (!isMultiWalletEnabled()) return totalSol;
  const w = _wallets.get(walletAddress);
  if (!w) return totalSol;
  return parseFloat((totalSol * w.capital_pct / 100).toFixed(6));
}

export function buildCapitalAwareWalletPlan(totalSol, desiredAmountSol, maxEntries = 1) {
  if (!isMultiWalletEnabled()) {
    const active = getActiveWallet();
    return {
      spread_ready: false,
      total_sol: totalSol,
      desired_amount_sol: desiredAmountSol,
      viable_wallets: active ? 1 : 0,
      selected_wallets: active ? [{
        address: active.address,
        label: active.label,
        deploy_amount_sol: desiredAmountSol,
        capital_pct: active.capital_pct,
        free_sol: totalSol,
      }] : [],
      summary: active ? "Single-wallet mode" : "No wallet available",
    };
  }

  return analyzeCapitalAwareWalletPlan({
    wallets: getAllWallets(),
    totalSol,
    desiredAmountSol,
    reserveSol: config.management.gasReserve ?? 0.2,
    maxEntries: Math.min(maxEntries, config.multiWallet?.maxWalletsPerBatch ?? 2),
    minTotalSol: config.multiWallet?.autoSpreadMinTotalSol ?? 3,
    minWalletDeploySol: config.multiWallet?.minWalletDeploySol ?? 0.25,
  });
}

export function buildAdaptiveTradeWalletPlan(tokenMint, amountSol, mode = "entry") {
  return planWalletExecution({
    wallets: getAllWallets(),
    tokenMint,
    amountSol,
    mode,
    maxWallets: config.multiWallet?.maxWalletsPerBatch ?? 2,
    splitThresholdSol: config.multiWallet?.autoSpreadMinTotalSol ?? 5,
  });
}

export function isMultiWalletEnabled() {
  return !!(config.multiWallet?.enabled && _wallets.size > 1);
}

function _recoverColdWallets() {
  const now = Date.now();
  for (const [addr, w] of _wallets) {
    if (w.status === "cold" && now >= w.cold_until) {
      w.status      = "hot";
      w.error_count = 0;
      log("wallet_mgr", `Wallet ${w.label} recovered → hot`);
      // Jika tidak ada active wallet hot, jadikan ini aktif
      const cur = _wallets.get(_activeAddress);
      if (!_activeAddress || !cur || cur.status !== "hot") {
        _activeAddress = addr;
        log("wallet_mgr", `Active wallet recovered: ${w.label}`);
      }
    }
  }
}
