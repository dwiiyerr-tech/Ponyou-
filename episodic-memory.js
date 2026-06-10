/**
 * episodic-memory.js — recall past trades by token fingerprint similarity.
 *
 * Unlike conviction-memory.js (per-mint), episodic memory keys on a COARSE
 * FINGERPRINT (mcap-band × liquidity-band × narrative × rug-band × tier × chain).
 * A brand-new mint still retrieves: "last N times I bought a token shaped like
 * this, outcomes were: WIN 64%, avg +38%, rug rate 9%."
 *
 * This turns the trade archive into forward-looking veto power on unseen tokens.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EPISODIC_FILE = process.env.PONYOU_EPISODIC_FILE
  || path.join(__dirname, "episodic-memory.json");

const MAX_RECENT_PER_KEY = 10;
const MAX_KEYS = 400;      // evict oldest on overflow

// ─── Persistence ─────────────────────────────────────────────────────────────

function _load() {
  try {
    if (fs.existsSync(EPISODIC_FILE)) {
      const d = JSON.parse(fs.readFileSync(EPISODIC_FILE, "utf8"));
      return { version: 1, episodes: {}, ...d };
    }
  } catch { /* corrupt → fresh */ }
  return { version: 1, episodes: {} };
}

function _save(data) {
  try { atomicWriteJson(EPISODIC_FILE, data); } catch { /* best-effort */ }
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────

const MCAP_BANDS  = [[0,10_000,"<10k"],[10_000,30_000,"10-30k"],[30_000,100_000,"30-100k"],[100_000,300_000,"100-300k"]];
const LIQ_BANDS   = [[0,2_000,"<2k"],[2_000,5_000,"2-5k"],[5_000,20_000,"5-20k"]];
const RUG_BANDS   = [[0,20,"low"],[20,50,"med"]];

function _band(value, bands, fallback = "high") {
  const v = Number(value) || 0;
  for (const [lo, hi, label] of bands) {
    if (v >= lo && v < hi) return label;
  }
  return fallback;
}

function _narrative(token) {
  const tags = Array.isArray(token.narrative_tags) ? token.narrative_tags : [];
  const first = typeof tags[0] === "string" ? tags[0] : (typeof tags[0] === "object" ? tags[0]?.narrative : null);
  if (first) return String(first).toLowerCase().slice(0, 20);
  return typeof token.narrative === "string" ? token.narrative.toLowerCase().slice(0, 20) : "other";
}

/**
 * Build a coarse, bucketed fingerprint string for a candidate token.
 * Pure, synchronous, no I/O.
 */
export function fingerprint(token = {}) {
  const mcap  = Number(token.mcap || token.market_cap || 0);
  const liq   = Number(token.liquidity || token.liq || 0);
  const rug   = Number(token.rug_score || 0);
  const chain = String(token.chain || "sol").toLowerCase();
  const tier  = String(token.tier || token.tier_execution?.tier || "UNKNOWN").toUpperCase().slice(0, 6);
  const narr  = _narrative(token);
  return [
    chain,
    `mcap:${_band(mcap, MCAP_BANDS)}`,
    `liq:${_band(liq, LIQ_BANDS)}`,
    `narr:${narr}`,
    `rug:${_band(rug, RUG_BANDS)}`,
    `tier:${tier}`,
  ].join("|");
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Record a closed trade into episodic memory.
 * Called at position exit in index.js.
 */
export async function recordEpisode({ mint, symbol, token = {}, pnl_pct = 0, hold_minutes = 0, exit_reason = "", is_rug = false } = {}) {
  return withFileLock(EPISODIC_FILE, async () => {
    try {
      const data = _load();
      const key  = fingerprint(token);
      if (!data.episodes[key]) {
        data.episodes[key] = { n: 0, wins: 0, rugs: 0, pnl_sum: 0, hold_sum_min: 0, last_ts: null, recent: [] };
      }
      const entry = data.episodes[key];
      entry.n++;
      if (pnl_pct > 0) entry.wins++;
      if (is_rug)       entry.rugs++;
      entry.pnl_sum     += pnl_pct;
      entry.hold_sum_min += hold_minutes;
      entry.last_ts     = new Date().toISOString();
      entry.recent      = [{ mint: String(mint || "").slice(0, 44), sym: String(symbol || "").slice(0, 12), pnl_pct: Number(pnl_pct.toFixed(2)), hold_min: Math.round(hold_minutes), reason: String(exit_reason || "").slice(0, 40), ts: entry.last_ts }, ...entry.recent].slice(0, MAX_RECENT_PER_KEY);

      // Evict oldest keys on overflow
      const keys = Object.keys(data.episodes);
      if (keys.length > MAX_KEYS) {
        const sorted = keys.sort((a, b) => (data.episodes[a].last_ts || "").localeCompare(data.episodes[b].last_ts || ""));
        for (const oldKey of sorted.slice(0, keys.length - MAX_KEYS)) delete data.episodes[oldKey];
      }
      _save(data);
    } catch (e) {
      log("episodic_err", e.message || e);
    }
  });
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Retrieve outcome stats for a candidate's fingerprint.
 * Returns null if fewer than minSamples recorded.
 */
export async function recallEpisodes(token = {}, { minSamples = 3 } = {}) {
  return withFileLock(EPISODIC_FILE, async () => {
    try {
      const data = _load();
      const key  = fingerprint(token);
      const entry = data.episodes[key];
      if (!entry || entry.n < minSamples) return null;
      const win_rate    = entry.n > 0 ? entry.wins / entry.n : 0;
      const rug_rate    = entry.n > 0 ? entry.rugs / entry.n : 0;
      const avg_pnl_pct = entry.n > 0 ? entry.pnl_sum / entry.n : 0;
      const median_hold = entry.n > 0 ? entry.hold_sum_min / entry.n : 0;

      let verdict;
      if (rug_rate >= 0.25 || win_rate < 0.30) verdict = "HISTORY_HOSTILE";
      else if (win_rate >= 0.55 && rug_rate < 0.15) verdict = "HISTORY_FAVORABLE";
      else verdict = "HISTORY_MIXED";

      return { key, matches: entry.n, win_rate, avg_pnl_pct, median_hold, rug_rate, verdict, sample: entry.recent.slice(0, 3) };
    } catch { return null; }
  });
}

/**
 * Build a terse prompt line for one candidate.
 * Returns null if no enough history.
 * Format: "SYMBOL: similar=N wr=X% avg=Y% rugs=Z% → VERDICT"
 */
export async function getEpisodicPromptLine(token = {}, opts = {}) {
  try {
    const recall = await recallEpisodes(token, opts);
    if (!recall) return null;
    const sym = String(token.symbol || token.mint || "?").slice(0, 12);
    return `${sym}: similar=${recall.matches} wr=${(recall.win_rate*100).toFixed(0)}% avg=${recall.avg_pnl_pct.toFixed(0)}% rugs=${(recall.rug_rate*100).toFixed(0)}% → ${recall.verdict}`;
  } catch { return null; }
}

/**
 * Build a [EPISODIC RECALL] block for all passing candidates.
 * Returns null when no history exists for any candidate.
 */
export async function getEpisodicBlock(candidates = [], opts = {}) {
  try {
    const linesPromises = candidates.map(t => getEpisodicPromptLine(t, opts));
    const lines = await Promise.all(linesPromises);
    const filteredLines = lines.filter(Boolean);
    if (filteredLines.length === 0) return null;
    return `[EPISODIC RECALL]\n${filteredLines.join("\n")}\n(HISTORY_HOSTILE = default SKIP unless trending_boost>20)`;
  } catch { return null; }
}

/**
 * Aggregate all episodic patterns into a strategy-design prompt block.
 * Unlike getEpisodicBlock (per-candidate recall), this scans the FULL store
 * and surfaces which coarse token shapes historically WIN vs LOSE —
 * giving the strategy evolution LLM concrete evidence to write better rules.
 *
 * Returns null when the store is empty or all patterns are below minSamples.
 */
export function getEpisodicSummaryBlock({ minSamples = 3, topN = 3 } = {}) {
  try {
    const data = _load();
    const entries = Object.entries(data.episodes || {});
    if (entries.length === 0) return null;

    const scored = entries
      .filter(([, e]) => e.n >= minSamples)
      .map(([key, e]) => ({
        key,
        n:       e.n,
        wr:      e.n > 0 ? e.wins / e.n : 0,
        avgPnl:  e.n > 0 ? e.pnl_sum / e.n : 0,
        rugRate: e.n > 0 ? e.rugs / e.n : 0,
      }));

    if (scored.length === 0) return null;

    const favorable = scored
      .filter(p => p.wr >= 0.55 && p.rugRate < 0.15)
      .sort((a, b) => b.wr - a.wr)
      .slice(0, topN);

    const hostile = scored
      .filter(p => p.rugRate >= 0.25 || p.wr < 0.30)
      .sort((a, b) => (b.rugRate - a.rugRate) || (a.wr - b.wr))
      .slice(0, topN);

    if (favorable.length === 0 && hostile.length === 0) return null;

    const fmt = p =>
      `${p.key} → n=${p.n} wr=${(p.wr*100).toFixed(0)}% avg=${p.avgPnl.toFixed(0)}% rugs=${(p.rugRate*100).toFixed(0)}%`;

    const lines = [`[EPISODIC PATTERNS — ${scored.length} fingerprints from trade history]`];
    for (const p of favorable) lines.push(`  FAVORABLE: ${fmt(p)}`);
    for (const p of hostile)   lines.push(`  HOSTILE:   ${fmt(p)}`);
    lines.push("  (Target FAVORABLE patterns, exclude HOSTILE ones in your strategy rules)");

    return lines.join("\n");
  } catch { return null; }
}

export function _resetEpisodicMemoryForTests() {
  try { if (fs.existsSync(EPISODIC_FILE)) fs.unlinkSync(EPISODIC_FILE); } catch { /* ignore */ }
}
