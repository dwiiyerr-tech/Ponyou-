/**
 * Rug Pattern Clustering — extracts shared fingerprints from rug-memory.json
 * and matches new tokens against learned + curated patterns.
 *
 * A "pattern" is a feature vector (set of boolean flags). When ≥3 historic rugs
 * share the same fingerprint, it auto-promotes to a rule.
 *
 * Curated seed patterns (rug-patterns-seed.json) bootstrap detection before
 * the agent has accumulated its own rug history.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE  = path.join(__dirname, "../rug-patterns-seed.json");
const LEARNED_FILE = path.join(__dirname, "../rug-patterns-learned.json");
const RUG_MEMORY_FILE = path.join(__dirname, "../rug-memory.json");

const MIN_OCCURRENCES_TO_LEARN = 3;

/**
 * Convert raw rug_signals into a boolean feature vector.
 * Thresholds chosen so common rugs hit the same bucket.
 */
export function extractFeatureVector(signals = {}) {
  return {
    high_top10:          (signals.top10_concentration_pct || 0) > 60,
    fresh_holders:       (signals.fresh_funded_holders || 0) >= 5,
    dust_holders:        (signals.dust_holders || 0) >= 5,
    has_freeze:          !!signals.freeze_authority,
    has_mint:            !!signals.mint_authority,
    creator_heavy:       (signals.creator_pct || 0) > 15,
    bundle_buy:          (signals.bundle_buyers_pct || 0) > 30,
    same_funder:         (signals.same_funder_holders || 0) >= 3,
    transfer_fee_high:   (signals.transfer_fee_bps || 0) >= 500,
    transfer_hook:       !!signals.transfer_hook,
    permanent_delegate:  !!signals.permanent_delegate,
    non_transferable:    !!signals.non_transferable,
    default_frozen:      !!signals.default_frozen,
    lp_unlocked:         signals.lp_locked === false,
    wash_trade:          (signals.wash_score || 0) >= 30,
  };
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Cluster historic rugs into patterns. Patterns occurring ≥MIN_OCCURRENCES
 * become rules with score weight proportional to occurrence count.
 */
export function learnPatterns() {
  const mem = loadJson(RUG_MEMORY_FILE, { patterns: [] });
  const rugs = mem.patterns || [];
  if (rugs.length < MIN_OCCURRENCES_TO_LEARN) {
    return { learned: 0, total_rugs: rugs.length, note: "not enough history" };
  }

  // Bucket by exact feature vector (only counting `true` features for stability)
  const buckets = new Map();
  for (const r of rugs) {
    const vec = extractFeatureVector(r.rug_signals || {});
    const trueFeatures = Object.entries(vec).filter(([_, v]) => v).map(([k]) => k).sort();
    if (trueFeatures.length === 0) continue;
    const key = trueFeatures.join("|");
    const bucket = buckets.get(key) || { features: trueFeatures, count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < 3) bucket.examples.push(r.symbol || r.mint?.slice(0, 8));
    buckets.set(key, bucket);
  }

  // Use the FULL feature signature so two patterns that share their first 3
  // features but differ in the remainder don't collapse into the same id.
  const learned = [...buckets.values()]
    .filter(b => b.count >= MIN_OCCURRENCES_TO_LEARN)
    .map(b => ({
      pattern_id: `learned_${b.features.join("_")}`,
      features: b.features,
      weight: Math.min(50, 15 + b.count * 5),
      occurrences: b.count,
      examples: b.examples,
      learned_at: new Date().toISOString(),
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  saveJson(LEARNED_FILE, { patterns: learned, last_run: new Date().toISOString() });

  log("rug_patterns", `Learned ${learned.length} patterns from ${rugs.length} rugs`);
  return { learned: learned.length, total_rugs: rugs.length, patterns: learned };
}

/**
 * Match a token's signals against all known patterns (seed + learned).
 * Returns matched patterns with their score weights.
 */
export function matchPatterns(signals) {
  const seed = loadJson(SEED_FILE, { patterns: [] }).patterns || [];
  const learned = loadJson(LEARNED_FILE, { patterns: [] }).patterns || [];
  const allPatterns = [...seed, ...learned];

  const tokenVec = extractFeatureVector(signals);
  const matched = [];

  for (const pat of allPatterns) {
    // A pattern matches if ALL its required features are present in the token.
    const required = pat.features || [];
    if (required.length < 1) continue;
    const allMatch = required.every(f => tokenVec[f] === true);
    if (allMatch) {
      matched.push({
        pattern_id: pat.pattern_id,
        features: required,
        weight: pat.weight || 20,
        source: pat.pattern_id?.startsWith("learned_") ? "learned" : "seed",
        occurrences: pat.occurrences || null,
        note: pat.note || null,
      });
    }
  }

  return matched;
}

export function listPatterns() {
  const seed = loadJson(SEED_FILE, { patterns: [] }).patterns || [];
  const learned = loadJson(LEARNED_FILE, { patterns: [] }).patterns || [];
  return {
    seed: seed.length,
    learned: learned.length,
    seed_patterns: seed,
    learned_patterns: learned,
  };
}
