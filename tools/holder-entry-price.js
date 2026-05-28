/**
 * Holder Entry Price Analysis (Improvement B)
 *
 * Estimate average holder entry price by analyzing acquisition patterns.
 * If 80%+ holders are underwater (bought higher than current price),
 * high sell pressure incoming.
 *
 * Approach: Use Helius transaction history to infer entry prices
 * Alternative (if Helius unavailable): estimate from price history at holder acquisition time
 *
 * Returns:
 *   {
 *     avg_entry_price_usd: X,
 *     current_price_usd: X,
 *     underwater_pct: X,  // % of holders currently underwater
 *     sell_pressure_risk: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
 *     confidence: 0-100,
 *     details: { holders_analyzed, first_buyer_at, last_buyer_at, ... }
 *   }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOLDER_ENTRY_CACHE_FILE = path.join(__dirname, "..", "holder-entry-prices.json");

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function loadEntryPriceCache() {
  if (!fs.existsSync(HOLDER_ENTRY_CACHE_FILE)) return { coins: {} };
  try {
    return JSON.parse(fs.readFileSync(HOLDER_ENTRY_CACHE_FILE, "utf8"));
  } catch {
    return { coins: {} };
  }
}

function saveEntryPriceCache(data) {
  atomicWriteJson(HOLDER_ENTRY_CACHE_FILE, data);
}

/**
 * Analyze holder entry prices from transaction history (via Helius).
 * For each top holder, find their first purchase and estimate entry price.
 *
 * @param {Object} args
 * @param {string} args.tokenMint - Token mint address
 * @param {number} args.currentPriceUsd - Current token price in USD
 * @param {Array} args.holderTransactions - [{address, txs: [{amount, priceUsd, timestamp}]}]
 * @param {Array} args.priceHistory - Optional: [{timestamp, priceUsd}] for fallback
 * @returns Entry price analysis object
 */
export function analyzeHolderEntryPrices({
  tokenMint,
  currentPriceUsd = 0,
  holderTransactions = [],
  priceHistory = [],
} = {}) {
  if (!tokenMint || holderTransactions.length === 0) {
    return {
      avg_entry_price_usd: 0,
      current_price_usd: currentPriceUsd,
      underwater_pct: 0,
      sell_pressure_risk: "UNKNOWN",
      confidence: 0,
      details: {
        holders_analyzed: 0,
        reason: "No transaction data available",
      },
    };
  }

  const currentPrice = safeNum(currentPriceUsd);
  // Underwater comparison requires a known current price. Without it every
  // positive entry would compare against 0 and report 100% underwater, which
  // would then trigger CRITICAL sell-pressure exits on tokens we simply don't
  // have a price feed for. Bail out and let the caller fall back to the
  // price-history estimator instead.
  if (currentPrice <= 0) {
    return {
      avg_entry_price_usd: 0,
      current_price_usd: 0,
      underwater_pct: 0,
      sell_pressure_risk: "UNKNOWN",
      confidence: 0,
      details: {
        holders_analyzed: 0,
        reason: "Current price unavailable — cannot compute underwater %",
      },
    };
  }
  const holderEntries = [];
  let totalUnderwaterCount = 0;

  // Process each holder's transaction history
  for (const holder of holderTransactions) {
    if (!holder.txs || holder.txs.length === 0) continue;

    // Find FIRST purchase (earliest timestamp = lowest entry price opportunity)
    const firstTx = holder.txs.reduce((earliest, tx) => {
      const ts1 = new Date(earliest.timestamp || 0).getTime();
      const ts2 = new Date(tx.timestamp || 0).getTime();
      return ts2 < ts1 ? tx : earliest;
    });

    const entryPrice = safeNum(firstTx.priceUsd || firstTx.price);
    if (entryPrice <= 0) continue; // skip invalid

    const isUnderwater = entryPrice > currentPrice;
    holderEntries.push({
      address: holder.address?.slice(0, 8) || "unknown",
      first_buy_at: firstTx.timestamp,
      entry_price: entryPrice,
      amount: safeNum(firstTx.amount),
      is_underwater: isUnderwater,
    });

    if (isUnderwater) {
      totalUnderwaterCount++;
    }
  }

  if (holderEntries.length === 0) {
    return {
      avg_entry_price_usd: 0,
      current_price_usd: currentPrice,
      underwater_pct: 0,
      sell_pressure_risk: "UNKNOWN",
      confidence: 0,
      details: {
        holders_analyzed: 0,
        reason: "No valid entry prices found",
      },
    };
  }

  // Calculate weighted average entry price
  const avgEntryPrice =
    holderEntries.reduce((sum, h) => sum + h.entry_price, 0) / holderEntries.length;
  const underwaterPct = (totalUnderwaterCount / holderEntries.length) * 100;

  // Determine sell pressure risk
  let sell_pressure_risk, confidence;
  if (underwaterPct >= 80) {
    sell_pressure_risk = "CRITICAL";
    confidence = 85;
  } else if (underwaterPct >= 60) {
    sell_pressure_risk = "HIGH";
    confidence = 80;
  } else if (underwaterPct >= 40) {
    sell_pressure_risk = "MEDIUM";
    confidence = 75;
  } else if (underwaterPct >= 20) {
    sell_pressure_risk = "LOW";
    confidence = 70;
  } else {
    sell_pressure_risk = "NONE";
    confidence = 65;
  }

  // Cache result — serialize the read-modify-write under file lock so
  // concurrent positions in the same management cycle don't clobber each
  // other's writes. Fire-and-forget: the caller doesn't depend on the
  // cache write completing, only on the in-memory return value below.
  withFileLock(HOLDER_ENTRY_CACHE_FILE, async () => {
    const cache = loadEntryPriceCache();
    if (!cache.coins[tokenMint]) cache.coins[tokenMint] = [];
    cache.coins[tokenMint].push({
      analyzed_at: nowIso(),
      avg_entry_price: avgEntryPrice,
      current_price: currentPrice,
      underwater_pct: underwaterPct,
      risk_level: sell_pressure_risk,
    });
    if (cache.coins[tokenMint].length > 20) {
      cache.coins[tokenMint] = cache.coins[tokenMint].slice(-20);
    }
    saveEntryPriceCache(cache);
  }).catch((err) => log("holder_entry_warn", `cache write failed: ${err.message}`));

  const sortedByEntry = [...holderEntries].sort(
    (a, b) => a.entry_price - b.entry_price
  );
  const medianEntryPrice =
    holderEntries.length % 2 === 0
      ? (sortedByEntry[Math.floor(holderEntries.length / 2) - 1].entry_price +
          sortedByEntry[Math.floor(holderEntries.length / 2)].entry_price) /
        2
      : sortedByEntry[Math.floor(holderEntries.length / 2)].entry_price;

  return {
    avg_entry_price_usd: Number(avgEntryPrice.toFixed(8)),
    median_entry_price_usd: Number(medianEntryPrice.toFixed(8)),
    current_price_usd: currentPrice,
    underwater_pct: Number(underwaterPct.toFixed(1)),
    sell_pressure_risk,
    confidence,
    details: {
      holders_analyzed: holderEntries.length,
      underwater_count: totalUnderwaterCount,
      price_disadvantage_pct:
        currentPrice > 0
          ? Number(
              (((avgEntryPrice - currentPrice) / currentPrice) * 100).toFixed(1)
            )
          : 0,
      earliest_buyer: sortedByEntry[0]?.first_buy_at || null,
      latest_buyer: sortedByEntry[holderEntries.length - 1]?.first_buy_at || null,
      top_underwater: holderEntries
        .filter((h) => h.is_underwater)
        .slice(0, 3)
        .map((h) => ({
          addr: h.address,
          entry: h.entry_price,
          loss_pct: Number(
            (((h.entry_price - currentPrice) / h.entry_price) * 100).toFixed(1)
          ),
        })),
    },
  };
}

/**
 * Simple fallback: estimate entry price from price history if no transaction data.
 * Assumes holders acquired at roughly the price when coin was most accessible
 * (lower prices = higher buyer activity).
 */
export function estimateEntryPriceFromHistory({
  tokenMint,
  currentPriceUsd = 0,
  priceHistory = [],
  holderAcquisitionSpread = 0.8, // 80% of holders acquired during "cheaper" 80% of history
} = {}) {
  if (!priceHistory || priceHistory.length < 2) {
    return {
      avg_entry_price_usd: currentPriceUsd,
      current_price_usd: currentPriceUsd,
      underwater_pct: 0,
      sell_pressure_risk: "UNKNOWN",
      confidence: 0,
      details: { reason: "Insufficient price history", method: "fallback" },
    };
  }

  // Sort by price ascending
  const sorted = [...priceHistory].sort((a, b) => safeNum(a.priceUsd) - safeNum(b.priceUsd));
  const cheaperPrices = sorted.slice(0, Math.floor(sorted.length * holderAcquisitionSpread));

  if (cheaperPrices.length === 0) {
    return {
      avg_entry_price_usd: currentPriceUsd,
      current_price_usd: currentPriceUsd,
      underwater_pct: 0,
      sell_pressure_risk: "UNKNOWN",
      confidence: 0,
      details: { reason: "No cheaper history available" },
    };
  }

  const estimatedEntryPrice =
    cheaperPrices.reduce((sum, p) => sum + safeNum(p.priceUsd), 0) / cheaperPrices.length;
  const currentPrice = safeNum(currentPriceUsd);
  const underwaterPct =
    currentPrice < estimatedEntryPrice
      ? ((estimatedEntryPrice - currentPrice) / estimatedEntryPrice) * 100
      : 0;

  let risk_level;
  if (underwaterPct >= 40) {
    risk_level = "HIGH";
  } else if (underwaterPct >= 20) {
    risk_level = "MEDIUM";
  } else if (underwaterPct > 0) {
    risk_level = "LOW";
  } else {
    risk_level = "NONE";
  }

  return {
    avg_entry_price_usd: Number(estimatedEntryPrice.toFixed(8)),
    current_price_usd: currentPrice,
    underwater_pct: Number(underwaterPct.toFixed(1)),
    sell_pressure_risk: risk_level,
    confidence: 40, // lower confidence for fallback
    details: {
      method: "estimated_from_price_history",
      cheaper_period_pct: Math.round(holderAcquisitionSpread * 100),
      reason: "Fallback when transaction data unavailable",
    },
  };
}

/**
 * Get cached entry price analysis for a mint.
 */
export function getCachedEntryAnalysis(tokenMint) {
  const cache = loadEntryPriceCache();
  const analyses = cache.coins[tokenMint] || [];
  return analyses.length > 0 ? analyses[analyses.length - 1] : null;
}
