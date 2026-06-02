/**
 * Multi-Chain Market Intelligence — per-chain activity scoring and
 * "hottest chain" ranking.
 *
 * Ponyou's existing market-intelligence.js reads ONE global market condition
 * from a mixed token pool (used for strategy gating). This module is ADDITIVE:
 * it scores each active chain (sol/base/bsc/eth) independently so the hunter
 * can dynamically prioritize allocation toward the hottest chain and starve
 * dead chains.
 *
 * Called by the hunter after GMGN trending/trenches fetches (NOT in the
 * screening cycle, to avoid extra latency). Persists to market-chain-intel.json.
 *
 * Conditions reuse the same HOT/COLD/etc scale as market-intelligence.js.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTEL_FILE = path.join(__dirname, "market-chain-intel.json");

// A snapshot is "fresh" for ranking if < FRESH_MS old. Beyond STALE_MS it is
// treated as dead/missing for allocation purposes.
const FRESH_MS = 10 * 60 * 1000; // 10 min
const STALE_MS = 15 * 60 * 1000; // 15 min

// Same thresholds as market-intelligence.js CONDITION_THRESHOLDS.
const CONDITION_THRESHOLDS = {
  extreme: { minSwaps: 5000, minBuyRatio: 0.6 },
  hot:     { minSwaps: 1000, minBuyRatio: 0.5 },
  normal:  { minSwaps: 200,  minBuyRatio: 0.4 },
  cold:    { minSwaps: 50,   minBuyRatio: 0.3 },
  // Below cold = DEAD
};

// Condition → ordinal, used to never pick a DEAD chain unless all are DEAD.
const CONDITION_RANK = { EXTREME: 4, HOT: 3, NORMAL: 2, COLD: 1, DEAD: 0 };

// ─── State I/O ────────────────────────────────────────────────

function loadIntel() {
  if (!fs.existsSync(INTEL_FILE)) return { chains: {}, lastUpdated: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(INTEL_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.chains) {
      return { chains: {}, lastUpdated: null };
    }
    return parsed;
  } catch {
    return { chains: {}, lastUpdated: null };
  }
}

function saveIntel(intel) {
  intel.lastUpdated = new Date().toISOString();
  atomicWriteJson(INTEL_FILE, intel);
}

// ─── Scoring (pure) ───────────────────────────────────────────

/**
 * Score one chain's activity from its normalized GMGN trending rows.
 * Pure function — fully testable in isolation.
 *
 * @param {string} chain  e.g. "sol" | "base" | "bsc" | "eth"
 * @param {Array}  tokens normalized GMGN trending rows for ONE chain
 * @param {number} rugActiveCount  number of high-rug-ratio tokens on this chain
 * @returns {{ chain, score, condition, metrics }}
 */
export function scoreChainActivity(chain, tokens, rugActiveCount = 0) {
  const list = Array.isArray(tokens) ? tokens : [];
  const rugActive = Number.isFinite(rugActiveCount) ? Math.max(0, rugActiveCount) : 0;

  if (list.length === 0) {
    return {
      chain,
      score: 0,
      condition: "DEAD",
      metrics: { avg_swaps: 0, vol_usd: 0, token_count: 0, buy_ratio: 0.5, rug_active_count: rugActive },
    };
  }

  const swapsList = list.map(t => Number(t.swaps ?? 0) || 0);
  const avgSwaps = swapsList.reduce((a, b) => a + b, 0) / swapsList.length;
  const volUsd = list.reduce((a, t) => a + (Number(t.volume ?? 0) || 0), 0);

  // Buy/sell pressure. GMGN trending rows rarely carry buy_vol/sell_vol, so
  // fall back to buy_count/sell_count, then a neutral 0.5.
  const buyVols = list.filter(t => t.buy_vol != null).map(t => Number(t.buy_vol) || 0);
  const sellVols = list.filter(t => t.sell_vol != null).map(t => Number(t.sell_vol) || 0);
  const totalBuy = buyVols.reduce((a, b) => a + b, 0);
  const totalSell = sellVols.reduce((a, b) => a + b, 0);
  let buyRatio;
  if (totalBuy + totalSell > 0) {
    buyRatio = totalBuy / (totalBuy + totalSell);
  } else {
    const buyCnt = list.reduce((a, t) => a + (Number(t.buy_count ?? t.buys ?? 0) || 0), 0);
    const sellCnt = list.reduce((a, t) => a + (Number(t.sell_count ?? t.sells ?? 0) || 0), 0);
    buyRatio = buyCnt + sellCnt > 0 ? buyCnt / (buyCnt + sellCnt) : 0.5;
  }

  const metrics = {
    avg_swaps: parseFloat(avgSwaps.toFixed(0)),
    vol_usd: parseFloat(volUsd.toFixed(0)),
    token_count: list.length,
    buy_ratio: parseFloat(buyRatio.toFixed(3)),
    rug_active_count: rugActive,
  };

  // ─── Condition (same scale as market-intelligence.js) ───
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

  // ─── Score 0-100 ───
  // Base: avg_swaps mapped logarithmically onto 0-70 (5000 swaps ≈ saturation),
  // scaled by a buy-ratio bonus, then a flat -10 penalty per active rug dev.
  // The rug penalty is what keeps the bot from chasing a "hot by volume"
  // chain that's actually a rug farm.
  const swapsComponent = Math.min(70, (avgSwaps / 5000) * 70);
  // buy_ratio in [0,1] → bonus multiplier in [0.5, 1.2]; neutral 0.5 → ~0.85.
  const buyRatioBonus = 0.5 + buyRatio * 0.7;
  let score = swapsComponent * buyRatioBonus;
  // small additive credit for breadth of activity (more active tokens = healthier)
  score += Math.min(15, list.length * 0.5);
  // rug penalty
  score -= rugActive * 10;

  score = Math.max(0, Math.min(100, Math.round(score)));

  return { chain, score, condition, metrics };
}

// ─── Persistence ──────────────────────────────────────────────

/**
 * Persist a snapshot for one chain. Called from the hunter after each GMGN
 * fetch. Synchronous-friendly: returns the snapshot, writes under a file lock.
 */
export function recordChainSnapshot(chain, tokens, rugActiveCount = 0) {
  const analysis = scoreChainActivity(chain, tokens, rugActiveCount);
  const snapshot = { ts: new Date().toISOString(), ...analysis };

  // Fire-and-forget under a lock; never let persistence errors break the hunt.
  withFileLock(INTEL_FILE, async () => {
    const intel = loadIntel();
    if (!intel.chains) intel.chains = {};
    intel.chains[chain] = snapshot;
    saveIntel(intel);
  }).catch(e => {
    try { log("market", `recordChainSnapshot(${chain}) persist failed: ${e.message}`); } catch {}
  });

  return snapshot;
}

// ─── Readers ──────────────────────────────────────────────────

function isFresh(snapshot, windowMs = FRESH_MS) {
  if (!snapshot || !snapshot.ts) return false;
  const age = Date.now() - new Date(snapshot.ts).getTime();
  return Number.isFinite(age) && age >= 0 && age < windowMs;
}

/**
 * Latest snapshot for a specific chain (regardless of freshness).
 * Returns null if no data.
 */
export function getChainIntelligence(chain) {
  const intel = loadIntel();
  return intel.chains?.[chain] ?? null;
}

/**
 * Map<chain, snapshot> for all chains with recent (< FRESH_MS) data.
 */
export function getAllChainIntelligence() {
  const intel = loadIntel();
  const out = new Map();
  for (const [chain, snap] of Object.entries(intel.chains || {})) {
    if (isFresh(snap)) out.set(chain, snap);
  }
  return out;
}

/**
 * Chains sorted by score DESC. Only includes chains with data < FRESH_MS old.
 * Returns an array of snapshot objects (each has .chain and .score).
 */
export function rankChainsByActivity() {
  const fresh = getAllChainIntelligence();
  return [...fresh.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // tie-break by condition ordinal
    return (CONDITION_RANK[b.condition] ?? 0) - (CONDITION_RANK[a.condition] ?? 0);
  });
}

/**
 * The single hottest chain (highest score). Never returns a DEAD chain unless
 * ALL fresh chains are DEAD (then falls back to the supplied default).
 */
export function getHottestChain(fallback = "sol") {
  const ranked = rankChainsByActivity();
  if (ranked.length === 0) return fallback;
  const alive = ranked.filter(s => s.condition !== "DEAD");
  if (alive.length > 0) return alive[0].chain;
  // all dead → keep the fallback chain rather than actively steering to a dead one
  return fallback;
}

/**
 * true if a chain's latest snapshot is DEAD, or missing/stale (> STALE_MS).
 */
export function isChainDead(chain) {
  const snap = getChainIntelligence(chain);
  if (!isFresh(snap, STALE_MS)) return true; // missing or stale
  return snap.condition === "DEAD";
}

/**
 * Allocation weights across the active chains, proportional to each chain's
 * score and normalized to sum 1.0. Dead/stale chains get weight 0.
 *
 * If every active chain is dead (or no data exists), falls back to an even
 * split so the hunter never starves itself completely.
 *
 * @param {string[]} activeChains  config.gmgn.chains
 * @returns {Object} { sol: 0.6, base: 0.3, bsc: 0.1 }
 */
export function getChainAllocationWeights(activeChains) {
  const chains = Array.isArray(activeChains) && activeChains.length > 0 ? activeChains : ["sol"];

  const scores = {};
  let total = 0;
  for (const chain of chains) {
    const snap = getChainIntelligence(chain);
    const dead = isChainDead(chain);
    // Floor at a small positive value for alive chains so a freshly-seen
    // alive-but-quiet chain still gets a sliver of allocation.
    const s = dead ? 0 : Math.max(1, snap?.score ?? 0);
    scores[chain] = s;
    total += s;
  }

  const weights = {};
  if (total <= 0) {
    // all dead / no data → even split (never fully starve the hunter)
    const even = parseFloat((1 / chains.length).toFixed(4));
    for (const chain of chains) weights[chain] = even;
    return weights;
  }

  for (const chain of chains) {
    weights[chain] = parseFloat((scores[chain] / total).toFixed(4));
  }
  return weights;
}

/** Test/maintenance helper: wipe the on-disk state. */
export function _resetChainIntel() {
  try { if (fs.existsSync(INTEL_FILE)) fs.unlinkSync(INTEL_FILE); } catch {}
}
