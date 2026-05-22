/**
 * Rug Pattern Clustering — extracts shared fingerprints from rug-memory.json
 * and matches new tokens against learned + curated patterns.
 *
 * A "pattern" is a feature vector (set of boolean flags). When ≥3 historic rugs
 * share the same fingerprint, it auto-promotes to a rule.
 *
 * Curated seed patterns (rug-patterns-seed.json) bootstrap detection before
 * the agent has accumulated its own rug history.
 *
 * Learned patterns stay soft by default until reviewed. That keeps the system
 * adaptive without letting one noisy cluster become a hard gate overnight.
 */

import fs from "fs";
import { atomicWriteJson } from "../atomic-write.js";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(__dirname, "../rug-patterns-seed.json");
const LEARNED_FILE = path.join(__dirname, "../rug-patterns-learned.json");
const RUG_MEMORY_FILE = path.join(__dirname, "../rug-memory.json");

const MIN_OCCURRENCES_TO_LEARN = 3;
const MIN_FEATURES_TO_LEARN = 1;
const LEARNED_WEIGHT_CAP = 35;
const UNREVIEWED_WEIGHT_CAP = 18;

/**
 * Convert raw rug_signals into a boolean feature vector.
 * Thresholds chosen so common rugs hit the same bucket.
 */
export function extractFeatureVector(signals = {}) {
  return {
    high_top10: (signals.top10_concentration_pct || 0) > 60,
    fresh_holders: (signals.fresh_funded_holders || 0) >= 5,
    dust_holders: (signals.dust_holders || 0) >= 5,
    has_freeze: !!signals.freeze_authority,
    has_mint: !!signals.mint_authority,
    creator_heavy: (signals.creator_pct || 0) > 15,
    bundle_buy: (signals.bundle_buyers_pct || 0) > 30,
    bundled_launch: !!signals.bundled || (signals.bundled_score || 0) > 5,
    top20_concentrated: !!signals.supply_concentrated || (signals.top20_pct || 0) > 60,
    same_funder: (signals.same_funder_holders || 0) >= 3,
    transfer_fee_high: (signals.transfer_fee_bps || 0) >= 500,
    transfer_hook: !!signals.transfer_hook,
    permanent_delegate: !!signals.permanent_delegate,
    non_transferable: !!signals.non_transferable,
    default_frozen: !!signals.default_frozen,
    lp_unlocked: signals.lp_locked === false,
    wash_trade: (signals.wash_score || 0) >= 30,
  };
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function saveJson(file, data) {
  atomicWriteJson(file, data);
}

function featureListFromSignals(signals = {}) {
  const vec = extractFeatureVector(signals);
  return Object.entries(vec).filter(([_, value]) => value).map(([key]) => key).sort();
}

function computeConfidence({ count = 0, total = 0, featureCount = 0 }) {
  const support = total > 0 ? count / total : 0;
  const breadth = Math.min(1, featureCount / 6);
  const countScore = Math.min(1, count / 8);
  const raw = 0.22 + (support * 0.38) + (breadth * 0.18) + (countScore * 0.22);
  return Number(Math.max(0.15, Math.min(0.95, raw)).toFixed(3));
}

function buildProvenance({ count, total, examples, features }) {
  return {
    source_file: path.basename(RUG_MEMORY_FILE),
    total_rugs: total,
    sample_count: count,
    feature_count: features.length,
    support_pct: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0,
    example_symbols: examples,
  };
}

function normalizeLearnedPattern(pattern, totalRugs) {
  const features = Array.isArray(pattern.features) ? [...pattern.features] : [];
  const count = Number(pattern.occurrences || pattern.sample_count || 0);
  const confidence = Number.isFinite(pattern.confidence_score)
    ? Number(pattern.confidence_score)
    : computeConfidence({ count, total: totalRugs, featureCount: features.length });
  const reviewed = pattern.review_status === "approved";

  return {
    ...pattern,
    features,
    occurrences: count,
    confidence_score: confidence,
    provenance: pattern.provenance || buildProvenance({
      count,
      total: totalRugs,
      examples: Array.isArray(pattern.examples) ? pattern.examples : [],
      features,
    }),
    review_status: pattern.review_status || (reviewed ? "approved" : "pending"),
    reviewed_at: pattern.reviewed_at || null,
    reviewed_by: pattern.reviewed_by || null,
    review_note: pattern.review_note || null,
    source: pattern.source || (pattern.pattern_id?.startsWith("learned_") ? "learned" : "seed"),
  };
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

  const buckets = new Map();
  for (const r of rugs) {
    const features = featureListFromSignals(r.rug_signals || {});
    if (features.length < MIN_FEATURES_TO_LEARN) continue;
    const key = features.join("|");
    const bucket = buckets.get(key) || { features, count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < 3) bucket.examples.push(r.symbol || r.mint?.slice(0, 8) || "unknown");
    buckets.set(key, bucket);
  }

  const learned = [...buckets.values()]
    .filter((bucket) => bucket.count >= MIN_OCCURRENCES_TO_LEARN)
    .map((bucket) => {
      const confidence = computeConfidence({
        count: bucket.count,
        total: rugs.length,
        featureCount: bucket.features.length,
      });
      const reviewed = confidence >= 0.8 && bucket.count >= 5;
      const weight = reviewed
        ? Math.min(LEARNED_WEIGHT_CAP, 18 + (bucket.count * 4) + (bucket.features.length * 2))
        : Math.min(UNREVIEWED_WEIGHT_CAP, 8 + (bucket.count * 2) + bucket.features.length);

      return {
        pattern_id: `learned_${bucket.features.join("_")}`,
        features: bucket.features,
        weight,
        occurrences: bucket.count,
        examples: bucket.examples,
        confidence_score: confidence,
        source: "learned",
        review_status: reviewed ? "approved" : "pending",
        reviewed_at: reviewed ? new Date().toISOString() : null,
        reviewed_by: reviewed ? "auto-confidence" : null,
        review_note: reviewed ? "Auto-promoted from high-confidence historical recurrence." : "Pending manual review before hard use.",
        provenance: buildProvenance({
          count: bucket.count,
          total: rugs.length,
          examples: bucket.examples,
          features: bucket.features,
        }),
        learned_at: new Date().toISOString(),
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences);

  saveJson(LEARNED_FILE, { patterns: learned, last_run: new Date().toISOString() });

  log("rug_patterns", `Learned ${learned.length} patterns from ${rugs.length} rugs`);
  return { learned: learned.length, total_rugs: rugs.length, patterns: learned };
}

/**
 * Review a learned pattern and promote it from pending to approved.
 * Approved patterns can carry full learned weight; pending patterns stay soft.
 */
export function approvePattern(patternId, { approvedBy = "human", note = "" } = {}) {
  const file = loadJson(LEARNED_FILE, { patterns: [] });
  const patterns = Array.isArray(file.patterns) ? file.patterns : [];
  const index = patterns.findIndex((pattern) => pattern.pattern_id === patternId);
  if (index < 0) return { approved: false, reason: `Pattern not found: ${patternId}` };

  patterns[index] = {
    ...patterns[index],
    review_status: "approved",
    reviewed_at: new Date().toISOString(),
    reviewed_by: approvedBy,
    review_note: note || patterns[index].review_note || "Approved by reviewer.",
  };

  saveJson(LEARNED_FILE, { ...file, patterns });
  return { approved: true, pattern: patterns[index] };
}

/**
 * Match a token's signals against all known patterns (seed + learned).
 * Returns matched patterns with their score weights.
 */
export function matchPatterns(signals) {
  const seed = (loadJson(SEED_FILE, { patterns: [] }).patterns || []).map((pattern) => ({
    ...pattern,
    source: pattern.source || "seed",
    review_status: pattern.review_status || "approved",
  }));
  const learnedRaw = loadJson(LEARNED_FILE, { patterns: [] }).patterns || [];
  const learned = learnedRaw.map((pattern) => normalizeLearnedPattern(pattern, loadJson(RUG_MEMORY_FILE, { patterns: [] }).patterns?.length || 0));
  const allPatterns = [...seed, ...learned];

  const tokenVec = extractFeatureVector(signals);
  const matched = [];

  for (const pat of allPatterns) {
    const required = pat.features || [];
    if (required.length < 1) continue;
    const allMatch = required.every((feature) => tokenVec[feature] === true);
    if (!allMatch) continue;

    const confidence = Number.isFinite(pat.confidence_score) ? pat.confidence_score : 1;
    const reviewed = pat.review_status === "approved" || pat.source !== "learned";
    const softOnly = pat.source === "learned" && !reviewed;
    const baseWeight = Number(pat.weight || 20);
    const effectiveWeight = pat.source === "learned"
      ? Math.max(1, Math.round(Math.min(reviewed ? LEARNED_WEIGHT_CAP : UNREVIEWED_WEIGHT_CAP, baseWeight * Math.max(0.35, confidence))))
      : baseWeight;

    matched.push({
      pattern_id: pat.pattern_id,
      features: required,
      weight: baseWeight,
      effective_weight: effectiveWeight,
      confidence_score: confidence,
      source: pat.source,
      review_status: pat.review_status || null,
      soft_only: softOnly,
      occurrences: pat.occurrences || null,
      note: pat.note || null,
      provenance: pat.provenance || null,
    });
  }

  return matched;
}

export function listPatterns() {
  const seed = loadJson(SEED_FILE, { patterns: [] }).patterns || [];
  const learned = loadJson(LEARNED_FILE, { patterns: [] }).patterns || [];
  const normalizedLearned = learned.map((pattern) => normalizeLearnedPattern(pattern, loadJson(RUG_MEMORY_FILE, { patterns: [] }).patterns?.length || 0));
  return {
    seed: seed.length,
    learned: normalizedLearned.length,
    pending_learned: normalizedLearned.filter((pattern) => pattern.review_status !== "approved").length,
    approved_learned: normalizedLearned.filter((pattern) => pattern.review_status === "approved").length,
    seed_patterns: seed,
    learned_patterns: normalizedLearned,
  };
}
