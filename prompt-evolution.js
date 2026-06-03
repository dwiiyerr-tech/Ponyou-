/**
 * prompt-evolution.js — outcome attribution → self-improving learned rules.
 *
 * Mines closed trades for deterministic correlations between token fingerprint
 * factors and outcomes. Emits up to 4 AVOID/FAVOR imperatives the LLM reads
 * back as hard rules. These update hourly — the screening prompt evolves from
 * the bot's own loss/win patterns without human intervention.
 *
 * Rule format the weak model follows reliably: "AVOID liq<2k: win_rate=14% (22 trades)"
 * Never a reasoning chain — always a declarative imperative.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { fingerprint as ep_fingerprint } from "./episodic-memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVOLUTION_FILE = process.env.PONYOU_PROMPT_EVOLUTION_FILE
  || path.join(__dirname, "prompt-evolution.json");

const RECOMPUTE_INTERVAL_MS = 60 * 60_000;  // 1 hour
const MIN_SAMPLES   = 5;
const MAX_RULES     = 4;

// ─── Persistence ─────────────────────────────────────────────────────────────

function _load() {
  try {
    if (fs.existsSync(EVOLUTION_FILE)) {
      const d = JSON.parse(fs.readFileSync(EVOLUTION_FILE, "utf8"));
      return { version: 1, factors: {}, rules: [], rules_ts: null, ...d };
    }
  } catch { /* corrupt → fresh */ }
  return { version: 1, factors: {}, rules: [], rules_ts: null };
}

function _save(data) {
  try { atomicWriteJson(EVOLUTION_FILE, data); } catch { /* best-effort */ }
}

// ─── Factor extraction ────────────────────────────────────────────────────────

function _extractFactors(token = {}, verdict = null) {
  const fp     = ep_fingerprint(token);
  const parts  = fp.split("|");
  const factors = [...parts];

  // verdict bucket
  if (verdict) factors.push(`verdict:${String(verdict).toLowerCase().slice(0, 20)}`);

  // feature aggregate bucket
  const feat = Number(token.feature_aggregate || 0);
  if (feat > 0) {
    factors.push(`feature:${feat >= 60 ? "60+" : feat >= 40 ? "40-60" : "<40"}`);
  }

  // rug score bucket (complement of episodic rug band)
  const rug = Number(token.rug_score || 0);
  if (rug >= 50) factors.push("rug:50+");
  else if (rug >= 30) factors.push("rug:30-50");

  return factors;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Record one closed trade into the factor accumulator.
 * Call at position exit in index.js.
 */
export function attributeOutcome({ token = {}, pnl_pct = 0, exit_reason = "", is_rug = false, verdict = null } = {}) {
  try {
    const data    = _load();
    const factors = _extractFactors(token, verdict);
    const isWin   = pnl_pct > 0 && !is_rug;
    for (const f of factors) {
      if (!data.factors[f]) data.factors[f] = { n: 0, wins: 0, rugs: 0, pnl_sum: 0 };
      data.factors[f].n++;
      if (isWin)  data.factors[f].wins++;
      if (is_rug) data.factors[f].rugs++;
      data.factors[f].pnl_sum += pnl_pct;
    }
    _save(data);
  } catch { /* best-effort */ }
}

// ─── Rule computation ─────────────────────────────────────────────────────────

function _recompute(data) {
  const rules = [];
  for (const [factor, s] of Object.entries(data.factors)) {
    if (s.n < MIN_SAMPLES) continue;
    const wr       = s.wins / s.n;
    const rugRate  = s.rugs / s.n;
    const avgPnl   = s.pnl_sum / s.n;

    if (rugRate >= 0.30 || wr <= 0.25) {
      rules.push({
        type: "AVOID",
        factor,
        label: `AVOID ${factor.replace(/\|/g, " ")}`,
        detail: `win_rate=${(wr*100).toFixed(0)}% rugs=${(rugRate*100).toFixed(0)}% (${s.n} trades)`,
        abs_pnl: Math.abs(s.pnl_sum),
        n: s.n,
      });
    } else if (wr >= 0.70 && avgPnl > 0) {
      rules.push({
        type: "FAVOR",
        factor,
        label: `FAVOR ${factor.replace(/\|/g, " ")}`,
        detail: `win_rate=${(wr*100).toFixed(0)}% avg_pnl=${avgPnl.toFixed(0)}% (${s.n} trades)`,
        abs_pnl: Math.abs(s.pnl_sum),
        n: s.n,
      });
    }
  }
  // Sort by |pnl_sum| descending (highest impact first), cap at MAX_RULES
  rules.sort((a, b) => b.abs_pnl - a.abs_pnl);
  return rules.slice(0, MAX_RULES).map(r => `${r.label}: ${r.detail}`);
}

/**
 * Explicitly trigger a rule recompute.
 */
export function recomputeLearnedRules() {
  try {
    const data = _load();
    data.rules    = _recompute(data);
    data.rules_ts = new Date().toISOString();
    _save(data);
    return data.rules;
  } catch { return []; }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

let _cachedBlock = null;
let _cacheTs     = 0;

/**
 * Get the [LEARNED RULES] prompt block. Recomputes hourly; reads from cache otherwise.
 * Returns null when no rules are meaningful yet.
 */
export function getLearnedRulesBlock() {
  try {
    const now = Date.now();
    if (_cachedBlock !== undefined && (now - _cacheTs) < RECOMPUTE_INTERVAL_MS) {
      return _cachedBlock;
    }

    const data = _load();
    let rules = data.rules || [];

    // Recompute if stale or empty
    if (!data.rules_ts || (now - new Date(data.rules_ts).getTime()) >= RECOMPUTE_INTERVAL_MS) {
      rules = _recompute(data);
      data.rules    = rules;
      data.rules_ts = new Date().toISOString();
      _save(data);
    }

    _cachedBlock = rules.length === 0 ? null
      : `[LEARNED RULES] (auto dari trade history — wajib dipatuhi)\n${rules.map(r => `- ${r}`).join("\n")}`;
    _cacheTs = now;
    return _cachedBlock;
  } catch { return null; }
}

export function _resetPromptEvolutionForTests() {
  _cachedBlock = null;
  _cacheTs = 0;
  try { if (fs.existsSync(EVOLUTION_FILE)) fs.unlinkSync(EVOLUTION_FILE); } catch { /* ignore */ }
}
