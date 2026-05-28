/**
 * Slow Rug Detector — gradual liquidity drain that's invisible to instant rug monitor
 *
 * Classic slow rug pattern:
 *   - Dev removes 5-10% liquidity, waits, repeats
 *   - Each removal alone is "normal volatility" — doesn't trip instant rug
 *   - Over 24-72h, total drain reaches 40-70%
 *   - Token then gets dumped after liquidity exit
 *
 * Detection approach:
 *   - Maintain per-token rolling liquidity history (timestamp + liquidity_usd)
 *   - On each cycle, compare current vs historical
 *   - Trigger on either:
 *     A) ≥3 distinct removals each ≥5% within 24h
 *     B) Total drain ≥30% over 48h while price stayed within ±20%
 *        (price stable = drain wasn't from organic sells)
 *
 * History persisted to slow-rug-history.json (capped per-token entries).
 * Stale tokens (>7 days no update) garbage-collected on read.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "..", "slow-rug-history.json");

const MAX_SAMPLES_PER_TOKEN = 50;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Storage ───────────────────────────────────────────────────────────

function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return { tokens: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return { tokens: parsed.tokens || {} };
  } catch { return { tokens: {} }; }
}

function writeHistory(state) { atomicWriteJson(HISTORY_FILE, state); }

function pruneStale(state) {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const mint of Object.keys(state.tokens)) {
    const samples = state.tokens[mint]?.samples || [];
    const fresh = samples.filter((s) => new Date(s.ts).getTime() >= cutoff);
    if (fresh.length === 0) {
      delete state.tokens[mint];
    } else {
      state.tokens[mint].samples = fresh.slice(-MAX_SAMPLES_PER_TOKEN);
    }
  }
}

/**
 * Record a liquidity snapshot for a token. Call this on each screening
 * cycle for tokens we're either holding or actively tracking.
 */
export async function recordLiquiditySample({ mint, liquidity_usd, price_usd } = {}) {
  if (!mint || !(Number(liquidity_usd) > 0)) return;
  await withFileLock(HISTORY_FILE, async () => {
    const state = readHistory();
    if (!state.tokens[mint]) state.tokens[mint] = { samples: [] };
    state.tokens[mint].samples.push({
      ts: new Date().toISOString(),
      liquidity_usd: Number(liquidity_usd),
      price_usd: Number(price_usd || 0),
    });
    // Cap per-token
    if (state.tokens[mint].samples.length > MAX_SAMPLES_PER_TOKEN) {
      state.tokens[mint].samples = state.tokens[mint].samples.slice(-MAX_SAMPLES_PER_TOKEN);
    }
    pruneStale(state);
    writeHistory(state);
  });
}

// ─── Detection logic ───────────────────────────────────────────────────

function withinWindow(samples, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return samples.filter((s) => new Date(s.ts).getTime() >= cutoff);
}

function countDistinctRemovals(samples, minDropPct = 0.05) {
  if (samples.length < 2) return { count: 0, biggest: 0 };
  let count = 0;
  let biggest = 0;
  const sorted = samples.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].liquidity_usd;
    const curr = sorted[i].liquidity_usd;
    if (!(prev > 0 && curr > 0)) continue;
    const dropPct = (prev - curr) / prev;
    if (dropPct >= minDropPct) {
      count++;
      if (dropPct > biggest) biggest = dropPct;
    }
  }
  return { count, biggest };
}

function totalDrainAndPriceStability(samples, hours) {
  const recent = withinWindow(samples, hours);
  if (recent.length < 2) return null;
  const sorted = recent.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const first = sorted[0];
  const last  = sorted[sorted.length - 1];
  const liqDrop = first.liquidity_usd > 0 ? (first.liquidity_usd - last.liquidity_usd) / first.liquidity_usd : 0;
  const priceMove = first.price_usd > 0 ? (last.price_usd - first.price_usd) / first.price_usd : 0;
  return {
    drain_pct: liqDrop,
    price_change_pct: priceMove,
    price_stable: Math.abs(priceMove) <= 0.20,
    first_ts: first.ts,
    last_ts: last.ts,
  };
}

/**
 * Evaluate slow-rug risk for a token from its accumulated history.
 *
 * @param {string} mint
 * @param {Object} opts — { minDropPct?, minRemovals24h?, minDrain48h?, requirePriceStable? }
 * @returns {{
 *   triggered: boolean,
 *   severity: 'none'|'watch'|'high',
 *   pattern: 'repeated_removals'|'gradual_drain'|null,
 *   evidence: Object | null,
 *   recommendation: string,
 * }}
 */
export function evaluateSlowRug(mint, opts = {}) {
  const cfg = {
    minDropPct:        0.05,
    minRemovals24h:    3,
    minDrain48h:       0.30,
    requirePriceStable: true,
    ...opts,
  };
  const state = readHistory();
  const samples = state.tokens[mint]?.samples || [];
  if (samples.length < 3) {
    return {
      triggered: false,
      severity: "none",
      pattern: null,
      evidence: { sample_count: samples.length, note: "insufficient history (need ≥3 samples)" },
      recommendation: "continue monitoring",
    };
  }

  // Pattern A: repeated small removals within 24h
  const last24 = withinWindow(samples, 24);
  const removalsA = countDistinctRemovals(last24, cfg.minDropPct);

  // Pattern B: gradual drain ≥30% over 48h with price stable
  const drain48 = totalDrainAndPriceStability(samples, 48);

  let triggered = false;
  let pattern = null;
  let evidence = null;
  let severity = "none";

  if (removalsA.count >= cfg.minRemovals24h) {
    triggered = true;
    pattern = "repeated_removals";
    severity = removalsA.count >= 5 ? "high" : "watch";
    evidence = {
      removal_events_24h: removalsA.count,
      biggest_drop_pct: Number((removalsA.biggest * 100).toFixed(1)),
    };
  } else if (drain48 && drain48.drain_pct >= cfg.minDrain48h && (!cfg.requirePriceStable || drain48.price_stable)) {
    triggered = true;
    pattern = "gradual_drain";
    severity = drain48.drain_pct >= 0.50 ? "high" : "watch";
    evidence = {
      drain_pct_48h: Number((drain48.drain_pct * 100).toFixed(1)),
      price_change_pct_48h: Number((drain48.price_change_pct * 100).toFixed(1)),
      price_stable: drain48.price_stable,
      window: [drain48.first_ts, drain48.last_ts],
    };
  }

  let recommendation = "continue monitoring";
  if (severity === "watch") recommendation = "tighten stop-loss, prepare exit";
  if (severity === "high")  recommendation = "FORCE EXIT — slow rug pattern confirmed";

  return { triggered, severity, pattern, evidence, recommendation };
}

export function _resetSlowRugForTests() {
  if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
}
