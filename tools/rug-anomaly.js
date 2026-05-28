/**
 * Rug Anomaly Detector — embedding-based similarity for detecting rug patterns
 * that don't exactly match any known fingerprint.
 *
 * Strategy: convert each rug in rug-memory.json into a numeric feature vector
 * (17 dimensions — one per boolean feature in the standard fingerprint).
 * For a new token, compute cosine similarity against all known rug vectors.
 * High similarity to known rugs → anomaly flag, even if exact pattern doesn't match.
 *
 * Pure JS math. Zero external API calls. O(rugs × features) ~= O(200 × 17).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// RA-1: `new URL(...).pathname` returns a leading-slash POSIX-style path on
// Windows (e.g. "/C:/Users/...") that fs.existsSync rejects. Use
// fileURLToPath so this resolves correctly cross-platform. Matches the
// convention used in every other ponyou module that needs __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUG_MEMORY_FILE = path.join(__dirname, "../rug-memory.json");

// The 17 features in the standard fingerprint (must match extractFeatureVector in rug-patterns.js)
const FEATURE_KEYS = [
  "high_top10",
  "fresh_holders",
  "dust_holders",
  "has_freeze",
  "has_mint",
  "creator_heavy",
  "bundle_buy",
  "bundled_launch",
  "top20_concentrated",
  "same_funder",
  "transfer_fee_high",
  "transfer_hook",
  "permanent_delegate",
  "non_transferable",
  "default_frozen",
  "lp_unlocked",
  "wash_trade",
];

// ─── Vector math ──────────────────────────────────────────────────

function dotProduct(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

function magnitude(v) {
  let m = 0;
  for (let i = 0; i < v.length; i++) m += v[i] * v[i];
  return Math.sqrt(m);
}

function cosineSimilarity(a, b) {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(a, b) / (magA * magB);
}

// ─── Feature extraction ───────────────────────────────────────────

/**
 * Convert rug_signals into a numeric feature vector (0/1 per dimension).
 * Identical threshold logic to extractFeatureVector() in rug-patterns.js.
 */
export function toNumericVector(signals = {}) {
  return [
    (signals.top10_concentration_pct || 0) > 60 ? 1 : 0,
    (signals.fresh_funded_holders || 0) >= 5 ? 1 : 0,
    (signals.dust_holders || 0) >= 5 ? 1 : 0,
    !!signals.freeze_authority ? 1 : 0,
    !!signals.mint_authority ? 1 : 0,
    (signals.creator_pct || 0) > 15 ? 1 : 0,
    (signals.bundle_buyers_pct || 0) > 30 ? 1 : 0,
    !!signals.bundled || (signals.bundled_score || 0) > 5 ? 1 : 0,
    !!signals.supply_concentrated || (signals.top20_pct || 0) > 60 ? 1 : 0,
    (signals.same_funder_holders || 0) >= 3 ? 1 : 0,
    (signals.transfer_fee_bps || 0) >= 500 ? 1 : 0,
    !!signals.transfer_hook ? 1 : 0,
    !!signals.permanent_delegate ? 1 : 0,
    !!signals.non_transferable ? 1 : 0,
    !!signals.default_frozen ? 1 : 0,
    signals.lp_locked === false ? 1 : 0,
    (signals.wash_score || 0) >= 30 ? 1 : 0,
  ];
}

// ─── Rug corpus loading ───────────────────────────────────────────

function loadRugVectors() {
  if (!fs.existsSync(RUG_MEMORY_FILE)) return [];
  try {
    const mem = JSON.parse(fs.readFileSync(RUG_MEMORY_FILE, "utf8"));
    const patterns = mem.patterns || [];
    return patterns
      .filter(p => p.rug_signals && Object.keys(p.rug_signals).length > 0)
      .map(p => ({
        mint: p.mint,
        symbol: p.symbol,
        vector: toNumericVector(p.rug_signals),
        notes: p.notes || "",
      }));
  } catch {
    return [];
  }
}

// ─── Main detector ────────────────────────────────────────────────

/**
 * Compare a new token's signals against all known rug vectors.
 *
 * @param {Object} signals — rug_signals object from gatherRugSignals() / scoreRugRisk()
 * @returns {{
 *   anomaly_score: number,      // 0-100, how similar to known rugs
 *   max_similarity: number,      // cosine sim to closest match
 *   closest_matches: Array,      // top 3 matches
 *   rug_corpus_size: number,     // total known rugs compared against
 *   anomaly_detected: boolean,   // true if anomaly_score >= 50
 * }}
 */
export function detectAnomaly(signals = {}) {
  const corpus = loadRugVectors();
  if (corpus.length < 10) {
    return { anomaly_score: 0, max_similarity: 0, closest_matches: [], rug_corpus_size: corpus.length, anomaly_detected: false };
  }

  const tokenVec = toNumericVector(signals);

  // Compute similarity to every known rug
  const similarities = corpus.map(rug => ({
    mint: rug.mint,
    symbol: rug.symbol,
    similarity: cosineSimilarity(tokenVec, rug.vector),
    notes: rug.notes,
  }));

  // Sort descending by similarity
  similarities.sort((a, b) => b.similarity - a.similarity);

  const maxSim = similarities[0]?.similarity || 0;
  const top3 = similarities.slice(0, 3).filter(s => s.similarity > 0.3);

  // Score: sigmoid-like mapping. 0.5 sim → 25, 0.7 → 60, 0.85 → 85
  const anomalyScore = Math.min(100, Math.round(maxSim * 100 * (maxSim > 0.5 ? 1.2 : 0.8)));

  return {
    anomaly_score: anomalyScore,
    max_similarity: parseFloat(maxSim.toFixed(4)),
    closest_matches: top3.map(m => ({
      symbol: m.symbol,
      similarity: parseFloat(m.similarity.toFixed(3)),
      notes: m.notes?.slice(0, 80),
    })),
    rug_corpus_size: corpus.length,
    anomaly_detected: anomalyScore >= 50,
  };
}

/**
 * Lightweight: for tokens with zero active flags (vector all zeros),
 * skip the full computation. Returns false = no anomaly possible.
 */
export function hasAnyActiveFlag(signals = {}) {
  return toNumericVector(signals).some(v => v > 0);
}
