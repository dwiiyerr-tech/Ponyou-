/**
 * Wallet Tier System — Classify & Track Wallets by Behavior
 *
 * TIER CATEGORIES:
 *
 *   S-TIER (Elite):
 *   └─ Proven winners with >60% WR over 50+ trades, high conviction
 *
 *   A-TIER (Smart Money):
 *   └─ 45-60% WR, 20+ trades, consistent profit, no rug history
 *
 *   B-TIER (Watchlist):
 *   └─ 35-45% WR, 10+ trades, mixed performance
 *
 *   INSIDER (Risky Signal):
 *   ├─ Wallets that bought token within 5 min of creation
 *   ├─ Wallets connected to deployer via funding
 *   └─ Multiple tokens bought before 100x pumps
 *
 *   DEVELOPER (Info Signal):
 *   ├─ Token deployer wallets
 *   ├─ Wallets that created 3+ tokens
 *   └─ Track for future launches
 *
 *   RUG (Danger Signal — BLOCK):
 *   ├─ Wallets involved in 2+ rug pulls
 *   ├─ Deployer of honeypot tokens
 *   └─ Freeze/mint abuse wallets
 *
 *   SNIPER (Neutral Signal):
 *   ├─ Wallets that buy within first block
 *   ├─ High bundle participation
 *   └─ Fast exit patterns
 *
 *   BOT (Info Signal):
 *   ├─ MEV/Trading bot wallets
 *   ├─ High-frequency trading patterns
 *   └─ Arbitrage patterns
 *
 * SIGNALS TO PONYOU:
 *   Insider buying → WARNING (potential dump incoming)
 *   Elite buying → STRONG BUY (follow the winners)
 *   Rug wallet involved → BLOCK ENTRY (danger)
 *   Developer launching new token → WATCH (potential rug or gem)
 *   Sniper accumulating → CAUTION (fast exit risk)
 */

import { log } from "../logger.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const WALLET_TIERS_FILE = path.join(PROJECT_ROOT, "wallet-tiers.json");

// ─── Tier Definitions ──────────────────────────────────────────

const TIER_CONFIG = {
  S_ELITE: {
    label: "S-Tier Elite",
    icon: "",
    minWinRate: 0.60,
    minTrades: 50,
    minProfitFactor: 1.5,
    signalOnBuy: "STRONG_BUY",
    signalOnSell: "STRONG_SELL",
    priority: 100,
    description: "Proven winners — follow their trades",
  },
  A_SMART_MONEY: {
    label: "A-Tier Smart Money",
    icon: "",
    minWinRate: 0.45,
    minTrades: 20,
    minProfitFactor: 1.2,
    signalOnBuy: "BUY",
    signalOnSell: "SELL",
    priority: 80,
    description: "Consistent performers — track closely",
  },
  B_WATCHLIST: {
    label: "B-Tier Watchlist",
    icon: "",
    minWinRate: 0.35,
    minTrades: 10,
    minProfitFactor: 0.8,
    signalOnBuy: "WATCH",
    signalOnSell: "WATCH",
    priority: 60,
    description: "Mixed performance — monitor",
  },
  INSIDER: {
    label: "Insider",
    icon: "",
    minWinRate: 0,
    minTrades: 0,
    signalOnBuy: "WARNING_DUMP_RISK",
    signalOnSell: "WARNING_DISTRIBUTION",
    priority: 90,
    description: "Connected to deployer — high dump risk",
    dangerLevel: "high",
  },
  DEVELOPER: {
    label: "Developer",
    icon: "",
    minWinRate: 0,
    minTrades: 0,
    signalOnBuy: "INFO_NEW_LAUNCH",
    signalOnSell: "INFO_SELLING",
    priority: 50,
    description: "Token creators — track for future launches",
  },
  RUG: {
    label: "Rug Puller",
    icon: "",
    minWinRate: 0,
    minTrades: 0,
    signalOnBuy: "BLOCK_ENTRY",
    signalOnSell: "BLOCK_ENTRY",
    priority: 200,
    description: "Known rug puller — DO NOT TRADE their tokens",
    dangerLevel: "critical",
  },
  SNIPER: {
    label: "Sniper",
    icon: "",
    minWinRate: 0,
    minTrades: 0,
    signalOnBuy: "CAUTION_FAST_EXIT",
    signalOnSell: "CAUTION_DUMPING",
    priority: 70,
    description: "First-block buyers — potential fast dump",
    dangerLevel: "medium",
  },
  BOT: {
    label: "Trading Bot",
    icon: "",
    minWinRate: 0,
    minTrades: 0,
    signalOnBuy: "INFO_BOT_ACTIVITY",
    signalOnSell: "INFO_BOT_ACTIVITY",
    priority: 30,
    description: "Automated trading — noise signal",
  },
};

// ─── State ──────────────────────────────────────────────────────

let _walletTiers = {
  wallets: {},       // address → { tier, label, stats, detectedAt, signals }
  stats: {
    totalTracked: 0,
    byTier: {},
    lastUpdated: null,
  },
};

function loadTiers() {
  try {
    if (fs.existsSync(WALLET_TIERS_FILE)) {
      _walletTiers = JSON.parse(fs.readFileSync(WALLET_TIERS_FILE, "utf8"));
    }
  } catch { /* use defaults */ }
}

function saveTiers() {
  try {
    _walletTiers.stats.totalTracked = Object.keys(_walletTiers.wallets).length;
    _walletTiers.stats.byTier = {};
    for (const w of Object.values(_walletTiers.wallets)) {
      const t = w.tier || "unknown";
      _walletTiers.stats.byTier[t] = (_walletTiers.stats.byTier[t] || 0) + 1;
    }
    _walletTiers.stats.lastUpdated = new Date().toISOString();
    atomicWriteJson(WALLET_TIERS_FILE, _walletTiers);
  } catch (e) {
    log("wallet_tiers_error", `Failed to save: ${e.message}`);
  }
}

loadTiers();

// ─── Classification Engine ──────────────────────────────────────

/**
 * Classify a wallet based on on-chain behavior patterns.
 */
export function classifyWallet(address, data = {}) {
  const {
    tradeCount = 0, winRate = 0, profitFactor = 0,
    avgHoldMinutes = 0, rugCount = 0, deployerOf = [],
    firstBlockBuys = 0, bundleParticipation = 0,
    insiderConnections = [], fundingFromDeployer = false,
    isContractDeployer = false, botPatterns = false,
    consecutiveRugs = 0,
  } = data;

  // ⚠️ RUG — highest priority check (safety first)
  if (rugCount >= 2 || consecutiveRugs >= 2) {
    return {
      tier: "RUG",
      confidence: Math.min(100, 60 + rugCount * 20),
      reasons: rugCount >= 3
        ? [`${rugCount} confirmed rug pulls — PERMANENT BLOCK`]
        : [`${rugCount} rug pulls detected — BLOCK`],
    };
  }

  // ⚠️ RUG — deployer of honeypots
  if (deployerOf.length >= 3 && winRate < 0.2) {
    return {
      tier: "RUG",
      confidence: 70,
      reasons: [`Deployed ${deployerOf.length} tokens with ${(winRate*100).toFixed(0)}% success — honeypot deployer`],
    };
  }

  // S-TIER ELITE
  if (tradeCount >= 50 && winRate >= 0.60 && profitFactor >= 1.5) {
    return {
      tier: "S_ELITE",
      confidence: Math.min(100, 60 + tradeCount * 0.5),
      reasons: [`${(winRate*100).toFixed(0)}% WR over ${tradeCount} trades, PF=${profitFactor.toFixed(1)}`],
    };
  }

  // INSIDER — connected to deployer
  if (fundingFromDeployer || insiderConnections.length >= 2) {
    return {
      tier: "INSIDER",
      confidence: fundingFromDeployer ? 85 : 60,
      reasons: fundingFromDeployer
        ? ["Funded by token deployer — insider connection"]
        : [`Connected to ${insiderConnections.length} deployer wallets`],
    };
  }

  // INSIDER — bought multiple tokens before pumps
  if (firstBlockBuys >= 5 && winRate >= 0.50) {
    return {
      tier: "INSIDER",
      confidence: 70,
      reasons: [`${firstBlockBuys} first-block buys with ${(winRate*100).toFixed(0)}% WR — insider timing`],
    };
  }

  // A-TIER SMART MONEY
  if (tradeCount >= 20 && winRate >= 0.45 && profitFactor >= 1.2) {
    return {
      tier: "A_SMART_MONEY",
      confidence: Math.min(100, 50 + tradeCount * 0.8),
      reasons: [`${(winRate*100).toFixed(0)}% WR over ${tradeCount} trades, PF=${profitFactor.toFixed(1)}`],
    };
  }

  // SNIPER
  if (firstBlockBuys >= 3 || bundleParticipation >= 5) {
    return {
      tier: "SNIPER",
      confidence: 65,
      reasons: firstBlockBuys >= 5
        ? [`${firstBlockBuys} first-block buys — active sniper`]
        : [`${bundleParticipation} bundle participations`],
    };
  }

  // B-TIER WATCHLIST
  if (tradeCount >= 10 && winRate >= 0.35) {
    return {
      tier: "B_WATCHLIST",
      confidence: 50,
      reasons: [`${(winRate*100).toFixed(0)}% WR over ${tradeCount} trades`],
    };
  }

  // DEVELOPER
  if (isContractDeployer || deployerOf.length >= 3) {
    return {
      tier: "DEVELOPER",
      confidence: isContractDeployer ? 80 : 55,
      reasons: isContractDeployer
        ? ["Token contract deployer"]
        : [`Deployed ${deployerOf.length} tokens`],
    };
  }

  // BOT
  if (botPatterns || (tradeCount > 100 && avgHoldMinutes < 2)) {
    return {
      tier: "BOT",
      confidence: 75,
      reasons: tradeCount > 100
        ? [`${tradeCount} trades, ${avgHoldMinutes.toFixed(0)}min avg hold — bot pattern`]
        : ["Detected bot trading patterns"],
    };
  }

  // UNCLASSIFIED
  return {
    tier: "B_WATCHLIST",
    confidence: 20,
    reasons: ["Insufficient data — watchlist by default"],
  };
}

// ─── Wallet Management ─────────────────────────────────────────

export function addWalletToTiers(address, data = {}) {
  const classification = classifyWallet(address, data);

  _walletTiers.wallets[address] = {
    address,
    tier: classification.tier,
    label: TIER_CONFIG[classification.tier]?.label || "Unknown",
    confidence: classification.confidence,
    reasons: classification.reasons,
    stats: {
      tradeCount: data.tradeCount || 0,
      winRate: data.winRate || 0,
      profitFactor: data.profitFactor || 0,
      rugCount: data.rugCount || 0,
      avgHoldMinutes: data.avgHoldMinutes || 0,
    },
    signals: {
      onBuy: TIER_CONFIG[classification.tier]?.signalOnBuy || "WATCH",
      onSell: TIER_CONFIG[classification.tier]?.signalOnSell || "WATCH",
    },
    priority: TIER_CONFIG[classification.tier]?.priority || 50,
    dangerLevel: TIER_CONFIG[classification.tier]?.dangerLevel || null,
    addedAt: new Date().toISOString(),
  };

  saveTiers();
  log("wallet_tiers", `Classified ${address.slice(0, 8)}... → ${classification.tier} (${classification.confidence}%)`);

  return _walletTiers.wallets[address];
}

export function getWalletTier(address) {
  return _walletTiers.wallets[address] || null;
}

export function getWalletsByTier(tier) {
  return Object.values(_walletTiers.wallets)
    .filter(w => w.tier === tier)
    .sort((a, b) => b.confidence - a.confidence);
}

export function getWalletSignal(address, action = "buy") {
  const wallet = _walletTiers.wallets[address];
  if (!wallet) return { signal: "UNKNOWN", priority: 0 };

  const signal = action === "buy" ? wallet.signals.onBuy : wallet.signals.onSell;
  return {
    signal,
    priority: wallet.priority,
    tier: wallet.tier,
    dangerLevel: wallet.dangerLevel,
    reason: wallet.reasons?.[0] || "Tracked wallet",
  };
}

/**
 * Check if ANY wallet in a list triggers a BLOCK signal.
 */
export function checkWalletSignals(walletAddresses = [], action = "buy") {
  const results = { block: false, warnings: [], buySignals: [], walletTiers: {} };

  for (const addr of walletAddresses) {
    const signal = getWalletSignal(addr, action);
    results.walletTiers[addr] = signal;

    if (signal.signal === "BLOCK_ENTRY") {
      results.block = true;
      results.warnings.push(`${addr.slice(0, 8)} is RUG tier — BLOCK ENTRY`);
    }
    if (signal.signal === "WARNING_DUMP_RISK" || signal.signal === "WARNING_DISTRIBUTION") {
      results.warnings.push(`${addr.slice(0, 8)} is INSIDER tier — ${signal.signal}`);
    }
    if (signal.signal === "STRONG_BUY" || signal.signal === "BUY") {
      results.buySignals.push(`${addr.slice(0, 8)} (${signal.tier}): ${signal.signal}`);
    }
  }

  return results;
}

// ─── Auto-Discovery ─────────────────────────────────────────────

/**
 * Scan recent trades for wallets worth adding to tiers.
 * Called periodically to grow the wallet tier database.
 */
export async function discoverWalletTiers(recentTxns = []) {
  const discovered = [];

  for (const tx of recentTxns) {
    const addr = tx.wallet || tx.address || tx.owner;
    if (!addr || _walletTiers.wallets[addr]) continue;

    // Check if this wallet has interesting patterns
    const data = {
      tradeCount: tx.trade_count || tx.swap_count || 0,
      winRate: tx.win_rate || tx.winrate || 0,
      profitFactor: tx.profit_factor || 0,
      rugCount: tx.rug_count || 0,
      firstBlockBuys: tx.first_block_buys || 0,
      fundingFromDeployer: tx.funded_by_deployer || false,
      isContractDeployer: tx.is_deployer || false,
      deployerOf: tx.deployed_tokens || [],
    };

    // Only add if there's enough data to classify
    if (data.tradeCount >= 5 || data.rugCount >= 1 || data.isContractDeployer || data.fundingFromDeployer) {
      const entry = addWalletToTiers(addr, data);
      discovered.push(entry);
    }
  }

  if (discovered.length > 0) {
    log("wallet_tiers", `Auto-discovered ${discovered.length} new wallets for tier tracking`);
  }

  return discovered;
}

// ─── Dashboard ──────────────────────────────────────────────────

export function getWalletTierStats() {
  const tiers = {};
  for (const tier of Object.keys(TIER_CONFIG)) {
    const wallets = getWalletsByTier(tier);
    tiers[tier] = {
      label: TIER_CONFIG[tier].label,
      count: wallets.length,
      signalOnBuy: TIER_CONFIG[tier].signalOnBuy,
      signalOnSell: TIER_CONFIG[tier].signalOnSell,
      topWallets: wallets.slice(0, 3).map(w => ({
        address: w.address.slice(0, 8) + "...",
        confidence: w.confidence,
        reason: w.reasons?.[0],
      })),
    };
  }

  return {
    stats: _walletTiers.stats,
    tiers,
    totalWallets: Object.keys(_walletTiers.wallets).length,
  };
}

export { TIER_CONFIG };
export default {
  classifyWallet, addWalletToTiers, getWalletTier,
  getWalletsByTier, getWalletSignal, checkWalletSignals,
  discoverWalletTiers, getWalletTierStats, TIER_CONFIG,
};
