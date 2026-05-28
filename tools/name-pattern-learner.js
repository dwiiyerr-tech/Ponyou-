/**
 * Name Pattern Learner — extracts recurring name/symbol patterns from rugged
 * tokens and builds runtime-injectable RegExp rules for the trash layer.
 *
 * Flow:
 *   recordRuggedName(symbol, name) → accumulates evidence
 *   compileLearnedNamePatterns()   → clusters and returns RegExp array
 *   loadLearnedNamePatterns()      → reads persisted rules from disk
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARNED_NAMES_FILE = path.join(__dirname, "../name-patterns-learned.json");
const MIN_OCCURRENCES = 3;   // how many times a feature must appear to become a rule
const MAX_RULES = 60;        // cap to avoid runaway bloat

// ─── Feature extractors ────────────────────────────────────────────────────
// Each extractor returns a string key representing a learnable pattern.
// If a key appears in ≥ MIN_OCCURRENCES rugged tokens it becomes a RegExp rule.

function extractFeatures(symbol = "", name = "") {
  const features = [];
  const sym = symbol.toUpperCase().trim();
  const nm  = (name || "").toLowerCase().trim();

  // Common 3-char prefix in symbol (e.g. "RUG", "FEK", "SCM")
  if (sym.length >= 3) features.push(`sym_prefix:${sym.slice(0, 3)}`);

  // Common suffix
  if (sym.length >= 3) features.push(`sym_suffix:${sym.slice(-3)}`);

  // All-digit suffix (e.g. "COIN2025", "TOKEN99")
  if (/\d{2,}$/.test(sym)) features.push("sym_digit_suffix");

  // Very long symbol (> 10 chars — likely AI-generated gibberish)
  if (sym.length > 10) features.push("sym_too_long");

  // Contains common bait words in name
  const baitWords = ["100x", "1000x", "moon", "gem", "launch", "presale", "airdrop", "free", "giveaway", "guaranteed"];
  for (const w of baitWords) {
    if (nm.includes(w)) features.push(`name_bait:${w}`);
  }

  // Mixed-case camel abuse (WeirdCoin, CoinXYZABC)
  if (/[A-Z][a-z]+[A-Z][a-z]+[A-Z]/.test(name)) features.push("name_camel_abuse");

  // Zero-width or non-ASCII heavy name
  if (/[^\x00-\x7F]{3,}/.test(name)) features.push("name_nonascii");
  if (/[​-‍﻿]/.test(name)) features.push("name_zerowidth");

  // Version number pattern ("V2", "V3", "2.0") — often clone rugs
  if (/v\d+$/i.test(sym) || /\d+\.\d+/.test(sym)) features.push("sym_version_clone");

  return features;
}

// ─── Persistence helpers ───────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(LEARNED_NAMES_FILE)) return { evidence: {}, rules: [], last_compiled: null };
  try { return JSON.parse(fs.readFileSync(LEARNED_NAMES_FILE, "utf8")); }
  catch { return { evidence: {}, rules: [], last_compiled: null }; }
}

function save(data) {
  atomicWriteJson(LEARNED_NAMES_FILE, data);
}

// NPL-4: feature keys can derive from arbitrary user/scraped strings, so
// any prefix/suffix segment that bleeds into `new RegExp(...)` needs to be
// escaped first. Without this, a rugged symbol containing a regex meta-
// character (e.g. "WIF*", "POPCAT.") would throw at compile or produce a
// wildly different pattern than intended.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Record a token that was confirmed rug/scam.
 * Called by learning-agent on every confirmed rug exit.
 */
export function recordRuggedName(symbol, name) {
  const data = load();
  if (!data.evidence) data.evidence = {};

  const features = extractFeatures(symbol, name);
  for (const f of features) {
    if (!data.evidence[f]) data.evidence[f] = { count: 0, examples: [] };
    data.evidence[f].count++;
    if (data.evidence[f].examples.length < 5 && symbol) {
      if (!data.evidence[f].examples.includes(symbol)) {
        data.evidence[f].examples.push(symbol);
      }
    }
  }

  save(data);
  return features;
}

/**
 * Compile evidence into RegExp rules. Called after every N new rugs.
 * Returns array of { pattern: RegExp, weight, source, note } objects.
 */
export function compileLearnedNamePatterns() {
  const data = load();
  const evidence = data.evidence || {};
  const rules = [];

  for (const [feature, stats] of Object.entries(evidence)) {
    if (stats.count < MIN_OCCURRENCES) continue;

    const examples = stats.examples.join(", ");
    const confidence = Math.min(1, stats.count / 10);
    const weight = Math.round(4 + confidence * 6); // 4-10 pts

    // Translate feature key → RegExp
    let pattern = null;
    let note = "";

    if (feature.startsWith("sym_prefix:")) {
      const prefix = feature.split(":")[1];
      // Only promote if it's not a common legitimate prefix
      if (!["SOL", "BTC", "ETH", "USD", "BNB", "ADA"].includes(prefix)) {
        pattern = new RegExp(`^${escapeRegex(prefix)}`, "i");
        note = `Learned: prefix "${prefix}" seen in ${stats.count} rugs (${examples})`;
      }
    } else if (feature.startsWith("sym_suffix:")) {
      const suffix = feature.split(":")[1];
      pattern = new RegExp(`${escapeRegex(suffix)}$`, "i");
      note = `Learned: suffix "${suffix}" seen in ${stats.count} rugs (${examples})`;
    } else if (feature === "sym_digit_suffix") {
      pattern = /\d{2,}$/;
      note = `Learned: digit suffix pattern seen in ${stats.count} rugs`;
    } else if (feature === "sym_too_long") {
      pattern = /^.{11,}$/;
      note = `Learned: symbol length >10 chars seen in ${stats.count} rugs`;
    } else if (feature.startsWith("name_bait:")) {
      const bait = feature.split(":")[1];
      pattern = new RegExp(`\\b${escapeRegex(bait)}\\b`, "i");
      note = `Learned: bait word "${bait}" seen in ${stats.count} rugs (${examples})`;
    } else if (feature === "name_camel_abuse") {
      pattern = /[A-Z][a-z]+[A-Z][a-z]+[A-Z]/;
      note = `Learned: camelCase abuse pattern seen in ${stats.count} rugs`;
    } else if (feature === "name_nonascii") {
      pattern = /[^\x00-\x7F]{3,}/;
      note = `Learned: non-ASCII heavy name seen in ${stats.count} rugs`;
    } else if (feature === "name_zerowidth") {
      pattern = /[​-‍﻿]/;
      note = `Learned: zero-width chars in name seen in ${stats.count} rugs`;
    } else if (feature === "sym_version_clone") {
      pattern = /v\d+$|\d+\.\d+/i;
      note = `Learned: version clone pattern seen in ${stats.count} rugs (${examples})`;
    }

    if (pattern) {
      rules.push({
        pattern,
        weight,
        source: "learned",
        feature,
        occurrences: stats.count,
        examples: stats.examples,
        note,
        learned_at: new Date().toISOString(),
      });
    }
  }

  // Cap and sort by occurrences descending
  const final = rules.sort((a, b) => b.occurrences - a.occurrences).slice(0, MAX_RULES);

  // Persist serializable version (pattern stored as string for JSON)
  save({
    evidence,
    rules: final.map(r => ({
      ...r,
      pattern: r.pattern.source,
      pattern_flags: r.pattern.flags,
    })),
    last_compiled: new Date().toISOString(),
  });

  log("name_pattern_learner", `Compiled ${final.length} name rules from ${Object.keys(evidence).length} features`);
  return final; // returns with actual RegExp objects
}

/**
 * Load persisted name patterns as RegExp objects.
 * Called by trash-layer on startup and after learning events.
 */
export function loadLearnedNamePatterns() {
  const data = load();
  const rules = data.rules || [];

  return rules
    .map(r => {
      try {
        return {
          pattern: new RegExp(r.pattern, r.pattern_flags || "i"),
          weight: r.weight || 4,
          source: "learned",
          note: r.note || "",
        };
      } catch { return null; }
    })
    .filter(Boolean);
}
