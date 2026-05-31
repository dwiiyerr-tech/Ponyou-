/**
 * Wallet Copy-Trade — bridges wallet ping events into actionable trading signals.
 *
 * Two modes:
 *   signal_only  — log + notify, no auto-trade (default)
 *   confirm_copy — require Telegram /yes before copying
 *   auto_copy    — automatically mirror priority wallet buys
 *
 * Priority wallets = smart wallets with win_rate >= 70% (configurable).
 */

import { listSmartWallets } from "../smart-wallets.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getSmartMoneyWallets, getKolWallets, getWalletStats, isGmgnEnabled } from "./gmgn.js";

// ─── Constants ──────────────────────────────────────────

const DEFAULT_COPY_TRADE = {
  enabled: false,
  mode: "signal_only",       // signal_only | confirm_copy | auto_copy
  maxCopySol: 0.1,           // max SOL per copy-trade
  minWalletWinRate: 0.70,    // min win rate for priority status
  maxSlippagePct: 15,        // max acceptable slippage
  cooldownMinutes: 10,       // min gap between copies from same wallet
  maxCopyPerDay: 5,          // global daily copy-trade cap
  requireMultiWallet: false, // require 2+ wallets confirming same token
};

// ─── Runtime state ──────────────────────────────────────

let _copyCountToday = 0;
let _copyDay = new Date().toDateString();
const _walletCooldowns = new Map(); // wallet -> last copy timestamp
const _signalLog = [];              // recent signals (max 200)

// ─── Priority Wallet Detection ──────────────────────────

export function getPriorityWallets(minWinRate = null) {
  const threshold = minWinRate ?? config.copyTrade?.minWalletWinRate ?? 0.70;
  const all = listSmartWallets();
  return all
    .filter(w => {
      const wr = w.stats?.winrate ?? w.selection?.win_rate ?? 0;
      return wr >= threshold;
    })
    .map(w => ({
      address: w.address,
      label: w.label || "",
      winRate: w.stats?.winrate ?? w.selection?.win_rate ?? 0,
      totalTrades: w.stats?.total_swaps ?? w.stats?.completed_trades ?? 0,
      realizedPnlSol: w.stats?.realized_pnl_sol ?? 0,
      followMode: w.follow_mode || "shadow",
      isPriority: true,
      lastActive: w.last_active || null,
    }))
    .sort((a, b) => b.winRate - a.winRate || b.realizedPnlSol - a.realizedPnlSol);
}

/**
 * Fetch live GMGN smart money + KOL wallets that meet priority threshold.
 * GMGN's smartmoney/kol endpoints are ACTIVITY FEEDS with no win rate, so we
 * derive distinct wallets, then enrich the most-active ones via wallet_stats
 * (where the real 0–1 win rate + USD PnL live) before applying the threshold.
 *
 * NOTE: realizedPnlUsd is in USD (GMGN's unit), not SOL.
 *
 * @param {number} [minWinRate=0.70]
 * @returns {Promise<Array>}
 */
export async function getGmgnPriorityWallets(minWinRate = null) {
  if (!isGmgnEnabled() || config.gmgn?.copyTrade === false) return [];
  const threshold = minWinRate ?? config.copyTrade?.minWalletWinRate ?? 0.70;
  // Cap enrichment: each wallet_stats call is rate-gated (~300ms) but cached
  // 15min, so warm calls are cheap; the cap bounds cold-cache latency.
  const enrichCap = config.gmgn?.enrichCap ?? 25;

  try {
    const [smartMoney, kols] = await Promise.all([
      getSmartMoneyWallets(100),
      getKolWallets(50),
    ]);
    const feed = [
      ...(Array.isArray(smartMoney) ? smartMoney : []),
      ...(Array.isArray(kols) ? kols : []),
    ].filter(w => w.address);

    // Enrich the most-active wallets only (each stat call is rate-gated).
    const out = [];
    for (const w of feed.slice(0, enrichCap)) {
      const stats = await getWalletStats(w.address, "30d");
      const s = Array.isArray(stats) ? stats[0] : stats;
      const winRate = s?.winRate ?? 0;
      if (winRate < threshold) continue;
      out.push({
        address: w.address,
        label: w.label || `gmgn_${w.type}`,
        winRate,
        totalTrades: s?.tradeCount ?? 0,
        realizedPnlUsd: s?.realizedPnlUsd ?? 0,
        followMode: "shadow",
        isPriority: true,
        lastActive: s?.lastActive ?? null,
        source: w.source || `gmgn_${w.type}`,
      });
    }
    return out.sort((a, b) => b.winRate - a.winRate || b.realizedPnlUsd - a.realizedPnlUsd);
  } catch (e) {
    log("copy_trade_warn", `GMGN priority wallets fetch failed: ${e.message}`);
    return [];
  }
}

// ─── Copy Trade Config ─────────────────────────────────

export function getCopyTradeConfig() {
  return { ...DEFAULT_COPY_TRADE, ...(config.copyTrade || {}) };
}

// ─── Signal Generation ─────────────────────────────────

/**
 * Process a wallet BUY event and generate a copy-trade signal.
 * Does NOT execute trades — returns signal classification.
 */
export function evaluateCopySignal({ wallet, token, pingResult } = {}) {
  const cfg = getCopyTradeConfig();
  if (!cfg.enabled) return { action: "skip", reason: "copy_trade_disabled" };

  // Reset daily counter
  const today = new Date().toDateString();
  if (today !== _copyDay) { _copyCountToday = 0; _copyDay = today; }

  // Daily cap
  if (_copyCountToday >= (cfg.maxCopyPerDay || 5)) {
    return { action: "skip", reason: "daily_copy_cap_reached" };
  }

  // Priority check
  const wr = wallet?.stats?.winrate ?? wallet?.selection?.win_rate ?? 0;
  if (wr < (cfg.minWalletWinRate || 0.70)) {
    return { action: "skip", reason: `wallet_win_rate_${wr.toFixed(2)}_below_threshold` };
  }

  // Cooldown check
  const lastCopy = _walletCooldowns.get(wallet.address);
  if (lastCopy && (Date.now() - lastCopy) < (cfg.cooldownMinutes || 10) * 60 * 1000) {
    return { action: "skip", reason: "wallet_cooldown" };
  }

  // Multi-wallet confirmation
  if (cfg.requireMultiWallet) {
    // Check if other priority wallets also bought same token (from signal log)
    const sameTokenSignals = _signalLog.filter(
      s => s.token === token?.mint && s.wallet !== wallet.address
    );
    const uniqueWallets = new Set(sameTokenSignals.map(s => s.wallet));
    if (uniqueWallets.size < 2) {
      return { action: "watching", reason: "awaiting_multi_wallet_confirmation" };
    }
  }

  // Generate signal
  const signal = {
    wallet: wallet.address,
    walletLabel: wallet.label || "",
    walletWinRate: wr,
    token: token?.mint || "",
    tokenSymbol: token?.symbol || "?",
    tokenPrice: token?.price || 0,
    tokenMcap: token?.mcap || 0,
    tokenLiquidity: token?.liquidity || 0,
    pingSeverity: pingResult?.severity || "MEDIUM",
    pingReasons: pingResult?.reasons || [],
    timestamp: new Date().toISOString(),
    action: cfg.mode === "auto_copy" ? "auto_copy"
          : cfg.mode === "confirm_copy" ? "awaiting_confirm"
          : "signal_only",
  };

  // Track
  _signalLog.unshift(signal);
  if (_signalLog.length > 200) _signalLog.length = 200;

  if (signal.action === "auto_copy") {
    _copyCountToday++;
    _walletCooldowns.set(wallet.address, Date.now());
  }

  // Log
  log("copy_trade", [
    `Signal: ${signal.action} | wallet=${signal.walletLabel || signal.wallet.slice(0, 8)}`,
    `token=${signal.tokenSymbol} | wr=${(signal.walletWinRate*100).toFixed(0)}%`,
    `mode=${cfg.mode}`,
  ].join(" "));

  return signal;
}

// ─── Recent Signals ────────────────────────────────────

export function getRecentSignals(limit = 20) {
  return _signalLog.slice(0, limit);
}

export function getCopyTradeStats() {
  return {
    copyCountToday: _copyCountToday,
    maxPerDay: getCopyTradeConfig().maxCopyPerDay || 5,
    mode: getCopyTradeConfig().mode || "signal_only",
    enabled: getCopyTradeConfig().enabled,
    priorityWalletCount: getPriorityWallets().length,
    recentSignals: _signalLog.slice(0, 5),
  };
}

// ─── Confirm / Execute ─────────────────────────────────

export function confirmCopySignal(signalIndex = 0) {
  if (signalIndex < 0 || signalIndex >= _signalLog.length) {
    return { error: "Invalid signal index" };
  }
  const signal = _signalLog[signalIndex];
  if (signal.action !== "awaiting_confirm") {
    return { error: `Signal not awaiting confirm, current status: ${signal.action}` };
  }
  const today = new Date().toDateString();
  if (today !== _copyDay) { _copyCountToday = 0; _copyDay = today; }
  if (_copyCountToday >= (getCopyTradeConfig().maxCopyPerDay || 5)) {
    return { error: "Daily copy cap reached" };
  }
  signal.action = "confirmed";
  _copyCountToday++;
  _walletCooldowns.set(signal.wallet, Date.now());
  log("copy_trade", `Copy confirmed: ${signal.tokenSymbol} from ${signal.walletLabel || signal.wallet.slice(0, 8)}`);
  return { ok: true, signal };
}

export function rejectCopySignal(signalIndex = 0) {
  if (signalIndex < 0 || signalIndex >= _signalLog.length) {
    return { error: "Invalid signal index" };
  }
  _signalLog[signalIndex].action = "rejected";
  return { ok: true };
}
