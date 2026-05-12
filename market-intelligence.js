/**
 * Market Intelligence — Detects market condition and adapts screening.
 *
 * Conditions:
 *   EXTREME  — insane volume/swaps, very high rug risk, extreme caution
 *   HOT      — active market, good alpha opportunities, normal operation
 *   NORMAL   — average conditions, standard filters
 *   COLD     — low volume/swaps, fewer opportunities, tighter filters
 *   DEAD     — market near-inactive, best to pause new entries
 */

import fs from "fs";
import { log } from "./logger.js";

const INTEL_FILE = "./market-intel.json";

// Rolling window: store the last N snapshots
const MAX_SNAPSHOTS = 48; // ~24h if checked every 30min

// ─── Thresholds ───────────────────────────────────────────────

const CONDITION_THRESHOLDS = {
  // avgSwaps per token in the top-20 candidates
  extreme: { minSwaps: 5000, minBuyRatio: 0.6 },
  hot:     { minSwaps: 1000, minBuyRatio: 0.5 },
  normal:  { minSwaps: 200,  minBuyRatio: 0.4 },
  cold:    { minSwaps: 50,   minBuyRatio: 0.3 },
  // Below cold = DEAD
};

// ─── State I/O ────────────────────────────────────────────────

function loadIntel() {
  if (!fs.existsSync(INTEL_FILE)) {
    return { snapshots: [], currentCondition: "NORMAL", lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(INTEL_FILE, "utf8"));
  } catch {
    return { snapshots: [], currentCondition: "NORMAL", lastUpdated: null };
  }
}

function saveIntel(intel) {
  intel.lastUpdated = new Date().toISOString();
  fs.writeFileSync(INTEL_FILE, JSON.stringify(intel, null, 2));
}

// ─── Analysis ─────────────────────────────────────────────────

/**
 * Compute market condition from a set of discovered tokens.
 * @param {Array} tokens - from discoverTokens()
 */
export function analyzeMarketCondition(tokens) {
  if (!tokens || tokens.length === 0) {
    return { condition: "DEAD", confidence: 0, metrics: {} };
  }

  const swapsList = tokens.map(t => t.swaps || 0);
  const avgSwaps = swapsList.reduce((a, b) => a + b, 0) / swapsList.length;
  const maxSwaps = Math.max(...swapsList);

  // Buy/sell pressure
  const buyVols = tokens.filter(t => t.buy_vol != null).map(t => t.buy_vol);
  const sellVols = tokens.filter(t => t.sell_vol != null).map(t => t.sell_vol);
  const totalBuy = buyVols.reduce((a, b) => a + b, 0);
  const totalSell = sellVols.reduce((a, b) => a + b, 0);
  const buyRatio = totalBuy + totalSell > 0 ? totalBuy / (totalBuy + totalSell) : 0.5;

  // Hot tokens count
  const hotCount = tokens.filter(t => (t.hot_level || 0) > 0).length;
  const hotRatio = hotCount / tokens.length;

  // Token creation rate (proxy: how many have created_at in last hour)
  const now = Date.now() / 1000;
  const freshCount = tokens.filter(t => t.created_at && (now - t.created_at) < 3600).length;

  const metrics = {
    avg_swaps: parseFloat(avgSwaps.toFixed(0)),
    max_swaps: maxSwaps,
    buy_ratio: parseFloat(buyRatio.toFixed(3)),
    hot_ratio: parseFloat(hotRatio.toFixed(3)),
    fresh_tokens_1h: freshCount,
    token_count: tokens.length,
  };

  let condition;
  if (avgSwaps >= CONDITION_THRESHOLDS.extreme.minSwaps && buyRatio >= CONDITION_THRESHOLDS.extreme.minBuyRatio) {
    condition = "EXTREME";
  } else if (avgSwaps >= CONDITION_THRESHOLDS.hot.minSwaps && buyRatio >= CONDITION_THRESHOLDS.hot.minBuyRatio) {
    condition = "HOT";
  } else if (avgSwaps >= CONDITION_THRESHOLDS.normal.minSwaps && buyRatio >= CONDITION_THRESHOLDS.normal.minBuyRatio) {
    condition = "NORMAL";
  } else if (avgSwaps >= CONDITION_THRESHOLDS.cold.minSwaps) {
    condition = "COLD";
  } else {
    condition = "DEAD";
  }

  // Adjust for bot-like patterns (extreme swaps + very low hot_ratio = bot activity, not real)
  if (condition === "EXTREME" && hotRatio < 0.2) {
    condition = "HOT"; // Downgrade: high swaps but not organic
  }

  const confidence = Math.min(100, Math.floor(hotRatio * 50 + Math.min(avgSwaps / 100, 50)));

  return { condition, confidence, metrics };
}

/**
 * Record a new market snapshot and update current condition.
 * Call this after every discoverTokens() call.
 */
export function recordMarketSnapshot(tokens) {
  const intel = loadIntel();
  const analysis = analyzeMarketCondition(tokens);

  intel.snapshots.push({
    ts: new Date().toISOString(),
    ...analysis,
  });

  // Keep rolling window
  if (intel.snapshots.length > MAX_SNAPSHOTS) {
    intel.snapshots = intel.snapshots.slice(-MAX_SNAPSHOTS);
  }

  // Smooth: condition must appear N times in a row to change
  const recent = intel.snapshots.slice(-3).map(s => s.condition);
  const dominantRecent = recent[recent.length - 1];
  const prevCondition = intel.currentCondition;

  // Hysteresis: only change if 2+ recent agree
  const agreesWithNew = recent.filter(c => c === dominantRecent).length;
  if (agreesWithNew >= 2) {
    intel.currentCondition = dominantRecent;
  }

  if (intel.currentCondition !== prevCondition) {
    log("market", `Market condition changed: ${prevCondition} → ${intel.currentCondition} (avg_swaps: ${analysis.metrics.avg_swaps})`);
  }

  saveIntel(intel);
  return { ...analysis, smoothed_condition: intel.currentCondition };
}

/**
 * Get current market condition with recommended config adjustments.
 */
export function getMarketIntelligence() {
  const intel = loadIntel();
  const condition = intel.currentCondition || "NORMAL";
  const recent = intel.snapshots.slice(-5);
  const latestMetrics = recent.length > 0 ? recent[recent.length - 1].metrics : {};

  return {
    condition,
    description: CONDITION_DESCRIPTIONS[condition],
    latest_metrics: latestMetrics,
    recommended_adjustments: getRecommendedAdjustments(condition),
    last_updated: intel.lastUpdated,
    snapshot_count: intel.snapshots.length,
  };
}

// ─── Adaptive Recommendations ─────────────────────────────────

const CONDITION_DESCRIPTIONS = {
  EXTREME: "Market sangat ramai/bot-heavy. Risiko rug sangat tinggi. Filter ketat.",
  HOT:     "Market aktif dan bergairah. Kesempatan alpha bagus. Operasi normal.",
  NORMAL:  "Kondisi pasar rata-rata. Filter standar dipakai.",
  COLD:    "Volume rendah. Sedikit peluang. Filter lebih ketat, pilih dengan hati-hati.",
  DEAD:    "Market hampir tidak aktif. Sebaiknya jangan entry baru.",
};

/**
 * Adaptive screening config changes based on market condition.
 * These are SUGGESTIONS — the agent can override.
 */
export function getRecommendedAdjustments(condition) {
  const adjustments = {
    EXTREME: {
      // Extremely cautious: max quality, avoid scams
      minHolders: 1000,
      minMcap: 500_000,
      maxMcap: 5_000_000,
      minVolume: 2000,
      maxBundlePct: 15,
      maxTop10Pct: 40,
      minTokenFeesSol: 60,
      maxBotHoldersPct: 15,
      note: "EXTREME — filter sangat ketat, banyak bot dan bundler aktif",
    },
    HOT: {
      // Aggressive: catch the wave
      minHolders: 300,
      minMcap: 100_000,
      maxMcap: 15_000_000,
      minVolume: 300,
      maxBundlePct: 30,
      maxTop10Pct: 60,
      minTokenFeesSol: 20,
      maxBotHoldersPct: 30,
      note: "HOT — market aktif, agresif tapi tetap selektif",
    },
    NORMAL: {
      // Standard defaults
      minHolders: 500,
      minMcap: 150_000,
      maxMcap: 10_000_000,
      minVolume: 500,
      maxBundlePct: 30,
      maxTop10Pct: 60,
      minTokenFeesSol: 30,
      maxBotHoldersPct: 30,
      note: "NORMAL — gunakan filter standar",
    },
    COLD: {
      // Wait for quality, don't force trades
      minHolders: 800,
      minMcap: 300_000,
      maxMcap: 8_000_000,
      minVolume: 1000,
      maxBundlePct: 20,
      maxTop10Pct: 50,
      minTokenFeesSol: 50,
      maxBotHoldersPct: 20,
      note: "COLD — market sepi, tunggu token berkualitas tinggi saja",
    },
    DEAD: {
      // Skip new entries entirely
      skip_entry: true,
      note: "DEAD — market tidak aktif, tunda entry baru",
    },
  };

  return adjustments[condition] || adjustments.NORMAL;
}

/**
 * Apply market intelligence adjustments to the live config.
 * Call this before each screening cycle.
 */
export function applyMarketAdjustments(userConfig, force = false) {
  const intel = getMarketIntelligence();
  const adj = intel.recommended_adjustments;

  if (!force && !userConfig.autoAdaptToMarket) return intel;

  // Only apply safe numeric fields
  const safeFields = ["minHolders", "minMcap", "maxMcap", "minVolume", "maxBundlePct", "maxTop10Pct", "minTokenFeesSol", "maxBotHoldersPct"];
  for (const field of safeFields) {
    if (adj[field] != null) userConfig[field] = adj[field];
  }

  return { ...intel, applied: true };
}

/**
 * Get a 24h trend summary from snapshots.
 */
export function getMarketTrend() {
  const intel = loadIntel();
  const snaps = intel.snapshots.slice(-24);
  if (snaps.length < 2) return { trend: "UNKNOWN", snapshots: snaps.length };

  const conditionScores = { EXTREME: 4, HOT: 3, NORMAL: 2, COLD: 1, DEAD: 0 };
  const scores = snaps.map(s => conditionScores[s.condition] ?? 2);
  const avgEarly = scores.slice(0, Math.floor(scores.length / 2)).reduce((a, b) => a + b, 0) / Math.floor(scores.length / 2);
  const avgLate = scores.slice(Math.floor(scores.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(scores.length / 2);

  let trend;
  if (avgLate > avgEarly + 0.5) trend = "HEATING_UP";
  else if (avgLate < avgEarly - 0.5) trend = "COOLING_DOWN";
  else trend = "STABLE";

  return {
    trend,
    avg_score_early: parseFloat(avgEarly.toFixed(2)),
    avg_score_late: parseFloat(avgLate.toFixed(2)),
    snapshots: snaps.length,
    conditions_24h: snaps.map(s => s.condition),
  };
}
