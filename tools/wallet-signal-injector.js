/**
 * Wallet Signal Injector
 * Bridges wallet ping events directly into the screening pipeline.
 *
 * Smart Money → screening injection (priority token discovery)
 * Rug Dev    → auto-warn → block token + notify
 *
 * Works alongside hunter-agent.js prey injection.
 * Called at the start of each screening cycle in index.js.
 */

import { listSmartWallets } from "../smart-wallets.js";
import { listBlockedDevs } from "../dev-blocklist.js";
import { listBlacklist, addToBlacklist } from "../token-blacklist.js";
import { agentBus } from "../agents/agent-bus.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { passesSmartMoneyFilter } from "../smart-money-filter.js";

// ─── In-memory signal cache (like hunter prey cache) ────

let _smartMoneySignals = [];
let _smartMoneyCachedAt = null;
const SIGNAL_TTL_MS = 15 * 60 * 1000; // 15 min TTL

let _rugDevAlerts = [];
let _rugDevCachedAt = null;
const RUG_ALERT_TTL_MS = 30 * 60 * 1000; // 30 min TTL

// Stats
let _injectorStats = {
  smSignalsInjected: 0,
  rugDevsBlocked: 0,
  lastInjection: null,
  inertReason: null,
};

// Log an inert-source diagnosis once per process (and surface it in stats),
// re-logging only if the reason changes.
let _lastInertReason = null;
function _noteInertSource(reason) {
  _injectorStats.inertReason = reason;
  if (reason !== _lastInertReason) {
    _lastInertReason = reason;
    log("wallet_signal", `smart-money source inert: ${reason}`);
  }
}

// ─── Smart Money Signal Detection ───────────────────────

/**
 * Scan smart wallets for recent BUY activity.
 * Returns tokens that priority wallets are buying RIGHT NOW.
 * These get injected into screening as high-priority candidates.
 */
export function detectSmartMoneySignals({ minWinRate = 0.60 } = {}) {
  const wallets = listSmartWallets();
  const smfEnabled = config.smartMoneyFilter?.enabled;
  const priorityWallets = wallets.filter(w => {
    const wr = w.stats?.winrate ?? w.selection?.win_rate ?? 0;
    if (wr < minWinRate) return false;
    // Quality filter: reject wallets that don't meet copy-trade criteria.
    if (smfEnabled) {
      const result = passesSmartMoneyFilter(w.stats || {}, config.smartMoneyFilter);
      if (!result.passes) {
        log("signal_injector", `${w.address?.slice(0, 8)} skipped (quality filter): ${result.failures.join(", ")}`);
        return false;
      }
    }
    return true;
  });

  // For now, signals come from the copy-trade signal log
  // In production, this would query on-chain data for real-time wallet activity
  const signals = [];
  // Visibility: every live wallet has sat in "shadow" mode since 2026-05-24,
  // so this source produced zero signals while looking healthy. Say so once
  // instead of silently returning [] forever.
  const actionable = priorityWallets.filter(w => ["active", "probe"].includes(w.follow_mode || "shadow"));
  if (priorityWallets.length > 0 && actionable.length === 0) {
    _noteInertSource(`${priorityWallets.length} qualifying wallets, all follow_mode=shadow — no smart-money signals will be generated (promote to active/probe to enable)`);
  }
  for (const wallet of priorityWallets) {
    const wr = wallet.stats?.winrate ?? wallet.selection?.win_rate ?? 0;
    const mode = wallet.follow_mode || "shadow";

    // Only active/probe mode wallets generate signals
    if (mode !== "active" && mode !== "probe") continue;

    signals.push({
      wallet: wallet.address,
      walletLabel: wallet.label || "",
      winRate: wr,
      totalTrades: wallet.stats?.total_swaps ?? wallet.stats?.completed_trades ?? 0,
      pnl: wallet.stats?.realized_pnl_sol ?? 0,
      followMode: mode,
      signalStrength: wr >= 0.85 ? "STRONG" : wr >= 0.70 ? "MODERATE" : "WEAK",
      source: "smart_money_wallet",
      priority: wr >= 0.85 ? 1 : wr >= 0.70 ? 2 : 3,
    });
  }

  return signals.sort((a, b) => a.priority - b.priority || b.winRate - a.winRate);
}

/**
 * Build synthetic token candidates from smart money wallet activity.
 * These are injected into the screening pipeline alongside DexScreener discovery.
 */
export function buildSmartMoneyCandidates(signals) {
  if (!signals || signals.length === 0) return [];

  return signals.map((sig, i) => ({
    // Minimal candidate structure — screening pipeline will enrich these
    mint: "", // Will be filled by wallet activity data
    symbol: "?",
    name: "SmartMoney Signal",
    price: 0,
    mcap: 0,
    liquidity: 0,
    volume: 0,
    swaps: 0,
    buys: 1,
    sells: 0,
    price_change_5m: 0,
    price_change_1h: 0,
    price_change_24h: 0,
    created_at: null,
    pair_address: null,
    dex: "unknown",
    launchpad: "unknown",
    _source: "smart_money_wallet",
    _smart_money: {
      wallet: sig.wallet,
      walletLabel: sig.walletLabel,
      winRate: sig.winRate,
      signalStrength: sig.signalStrength,
    },
    _hunter_score: sig.winRate >= 0.85 ? 85 : sig.winRate >= 0.70 ? 65 : 50,
    _hunter_tier: sig.winRate >= 0.85 ? "PRIORITY" : "GOOD",
    _hunter_reasons: [`smart_wallet:${sig.walletLabel || sig.wallet.slice(0, 8)}:wr${(sig.winRate*100).toFixed(0)}`],
    _hunter_source: "smart_money_wallet",
    narrative_tags: [],
    hot_level: sig.winRate >= 0.85 ? 3 : 2,
    creator: null,
    timeframe: "1h",
  }));
}

// ─── Rug Developer Detection ────────────────────────────

/**
 * Check if a token's creator/deployer is a known rug developer.
 * Returns alert info for auto-blocking.
 */
export function checkRugDevDeployer({ creatorWallet, tokenMint, tokenSymbol } = {}) {
  if (!creatorWallet) return null;

  const blockedDevs = listBlockedDevs();
  const isRugDev = blockedDevs.some(d => {
    const addr = (d.address || "").toLowerCase();
    return addr === creatorWallet.toLowerCase();
  });

  if (!isRugDev) return null;

  const devInfo = blockedDevs.find(d =>
    (d.address || "").toLowerCase() === creatorWallet.toLowerCase()
  );

  return {
    type: "RUG_DEV_DEPLOYER",
    severity: "CRITICAL",
    creatorWallet,
    devReason: devInfo?.reason || "Known rug developer",
    tokenMint: tokenMint || "",
    tokenSymbol: tokenSymbol || "?",
    action: "BLOCK",
    reason: `Token deployed by known rug developer: ${creatorWallet}`,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Auto-block a token deployed by a rug developer.
 * Returns the block result.
 */
export async function autoBlockRugDevToken({ creatorWallet, tokenMint, tokenSymbol } = {}) {
  if (!tokenMint) return { blocked: false, reason: "no_token_mint" };

  const result = await addToBlacklist({
    mint: tokenMint,
    reason: `Auto-blocked: rug dev ${creatorWallet} deployed ${tokenSymbol || "?"}`,
  });

  if (!result.saved) return { blocked: false, reason: result.reason || "already_blacklisted" };

  _injectorStats.rugDevsBlocked++;

    // Emit alert
    agentBus.emit("wallet:rug_dev_blocked", {
      creatorWallet,
      tokenMint,
      tokenSymbol,
      reason: result.reason,
      timestamp: new Date().toISOString(),
    });

    log("wallet_signal", [
      `RUG DEV BLOCKED: ${tokenSymbol || "?"} (${tokenMint.slice(0, 8)}...)`,
      `deployer=${creatorWallet.slice(0, 8)}...`,
    ].join(" | "));

  return result;
}

// ─── Screening Injection ────────────────────────────────

/**
 * Get smart money signals for injection into the screening pipeline.
 * Called at the start of each screening cycle.
 * Mirrors the hunter prey injection pattern.
 */
export function getSmartMoneyCandidates({ minWinRate = 0.60 } = {}) {
  // Check cache TTL
  if (_smartMoneyCachedAt && (Date.now() - _smartMoneyCachedAt) <= SIGNAL_TTL_MS) {
    return buildSmartMoneyCandidates(_smartMoneySignals);
  }
  
  _smartMoneySignals = [];
  _smartMoneyCachedAt = null;

  const signals = detectSmartMoneySignals({ minWinRate });
  const now = Date.now();

  // Only emit bus events for fresh signals
  if (signals.length > 0) {
    for (const sig of signals.slice(0, 5)) {
      agentBus.emit("wallet:smart_money_signal", {
        ...sig,
        timestamp: now,
      });
    }
  }

  _smartMoneySignals = signals;
  _smartMoneyCachedAt = now;
  _injectorStats.smSignalsInjected += signals.length;
  _injectorStats.lastInjection = new Date().toISOString();

  if (signals.length > 0) {
    _injectorStats.inertReason = null;
    _lastInertReason = null;
    const strongCount = signals.filter(s => s.signalStrength === "STRONG").length;
    log("wallet_signal", [
      `Smart Money signals: ${signals.length} wallets`,
      `(${strongCount} STRONG) → injecting into screening`,
    ].join(" "));
  }

  // Build candidates (signals only - actual tokens resolved when wallet activity detected)
  return buildSmartMoneyCandidates(signals);
}

/**
 * Inject wallet ping candidates into the screening token list.
 * Works exactly like injectHunterPrey — merges with discovery tokens.
 */
export function injectWalletPingCandidates(screeningTokens, walletTokens, maxInject = 10) {
  if (!Array.isArray(walletTokens) || walletTokens.length === 0) {
    return screeningTokens;
  }

  const existingMints = new Set(
    Array.isArray(screeningTokens) ? screeningTokens.map(t => t.mint).filter(Boolean) : []
  );

  // Take top-scored wallet ping tokens not already in the screening list
  // Skip tokens without a mint (pure signals that haven't resolved to a token yet)
  const newPrey = walletTokens
    .filter(t => t.mint && !existingMints.has(t.mint) && t._hunter_score >= 40)
    .slice(0, maxInject);

  if (newPrey.length === 0) return screeningTokens || [];

  log("wallet_signal", `Injecting ${newPrey.length} wallet ping candidates into screening`);

  return [...(Array.isArray(screeningTokens) ? screeningTokens : []), ...newPrey];
}

// ─── Rug Dev Alerts ─────────────────────────────────────

/**
 * Get recent rug dev alerts.
 */
export function getRugDevAlerts(limit = 10) {
  // Check TTL
  if (_rugDevCachedAt && (Date.now() - _rugDevCachedAt) > RUG_ALERT_TTL_MS) {
    _rugDevAlerts = [];
    _rugDevCachedAt = null;
  }
  return _rugDevAlerts.slice(0, limit);
}

/**
 * Record a rug dev alert (called when rug dev activity detected).
 */
export function recordRugDevAlert(alert) {
  _rugDevAlerts.unshift(alert);
  if (_rugDevAlerts.length > 50) _rugDevAlerts.length = 50;
  _rugDevCachedAt = Date.now();
}

// ─── Stats ──────────────────────────────────────────────

export function getWalletSignalStats() {
  return {
    ..._injectorStats,
    cachedSmSignals: _smartMoneySignals.length,
    cachedRugAlerts: _rugDevAlerts.length,
  };
}

// ─── Initialize ─────────────────────────────────────────

let _initialized = false;

export function initWalletSignalInjector() {
  if (_initialized) return;
  _initialized = true;

  // Listen for rug dev events from the broader system
  agentBus.subscribe("wallet:rug_dev_detected", async (payload) => {
    const alert = checkRugDevDeployer({
      creatorWallet: payload?.creatorWallet,
      tokenMint: payload?.tokenMint,
      tokenSymbol: payload?.tokenSymbol,
    });

    if (alert) {
      recordRugDevAlert(alert);
      await autoBlockRugDevToken({
        creatorWallet: alert.creatorWallet,
        tokenMint: alert.tokenMint,
        tokenSymbol: alert.tokenSymbol,
      });
    }
  });

  log("wallet_signal", "Wallet Signal Injector initialized");
}
