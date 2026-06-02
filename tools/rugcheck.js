/**
 * RugCheck.xyz API — token risk verification.
 *
 * Free API (no key required for basic checks):
 *   GET /v1/tokens/{mint}/report  → full rug report
 *   GET /v1/tokens/{mint}/summary → quick summary
 *
 * Report returns:
 *   - tokenProgram: SPL Token or Token-2022
 *   - freezeAuthority, mintAuthority: null or address
 *   - topHolders: concentration distribution
 *   - markets: LP lock status per DEX
 *   - rugScore: 0 (safe) to 100 (certain rug)
 *   - risks: array of detected risk factors
 *   - tokenMeta: name, symbol, uri validation
 */

import { log } from "../logger.js";

const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";

// Cache: 10 min TTL. Rug status doesn't change second-to-second but
// shorter than Helius cache because RugCheck is free and fast.
const _cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function cached(key) {
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.value;
  return null;
}

function putCache(key, value) {
  _cache.set(key, { ts: Date.now(), value });
  if (_cache.size > 500) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}

async function fetchRugCheck(path, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1200 * i));
    try {
      const res = await fetch(`${RUGCHECK_BASE}${path}`, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 4000 * (i + 1))); continue; }
      if (res.status === 404 || res.status === 400) return { not_found: true };
      if (!res.ok) throw new Error(`RugCheck ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("RugCheck fetch failed");
}

// ─── Full Report ──────────────────────────────────────────────────

/**
 * Get full RugCheck report for a token.
 * Maps RugCheck risk factors to Ponyou's internal scoring.
 */
export async function getRugCheckReport(mint) {
  const key = `report:${mint}`;
  const hit = cached(key);
  if (hit) return hit;

  try {
    const data = await fetchRugCheck(`/tokens/${mint}/report`);

    if (data?.not_found) {
      // Token not yet indexed by RugCheck — that's fine for very new tokens
      return { mint, indexed: false, score: null, risks: [], note: "not yet indexed by RugCheck" };
    }

    // Map RugCheck risks to Ponyou signals
    const risks = (data?.risks || []).map(r => ({
      name: r.name || "unknown",
      description: r.description || "",
      level: r.level || "warn",   // "warn" | "danger" | "critical"
      score_impact: r.level === "critical" ? 30 : r.level === "danger" ? 15 : 5,
    }));

    const topHolders = (data?.topHolders || []).slice(0, 10);
    const top10Pct = topHolders.reduce((s, h) => s + (h.pct || 0), 0);

    const result = {
      mint,
      indexed: true,
      rug_score_rugcheck: data?.score ?? 0,
      token_program: data?.tokenProgram || "spl-token",
      freeze_authority: data?.freezeAuthority || null,
      mint_authority: data?.mintAuthority || null,
      lp_locked: data?.markets?.some(m => m.lp?.lpLocked) || false,
      lp_burned: data?.markets?.some(m => m.lp?.lpBurned) || false,
      top10_concentration_pct: parseFloat(top10Pct.toFixed(1)),
      holder_count: topHolders.length,
      risks,
      total_risk_score: risks.reduce((s, r) => s + r.score_impact, 0),
      verified: data?.tokenMeta?.verified || false,
      _source: "rugcheck",
    };
    putCache(key, result);
    return result;
  } catch (e) {
    log("rugcheck_warn", `Report ${mint.slice(0, 8)}: ${e.message}`);
    return { mint, indexed: false, score: null, risks: [], error: e.message, _source: "rugcheck" };
  }
}

// ─── Quick Summary ────────────────────────────────────────────────

/**
 * Lightweight: only rug_score + top risks. Faster, less data.
 * Use for quick pre-screening when full report is overkill.
 */
export async function getRugCheckSummary(mint) {
  const key = `summary:${mint}`;
  const hit = cached(key);
  if (hit) return hit;

  try {
    const data = await fetchRugCheck(`/tokens/${mint}/summary`);
    if (data?.not_found) {
      return { mint, indexed: false, score: null, risks: 0 };
    }
    const result = {
      mint,
      indexed: true,
      rug_score: data?.score ?? 0,
      total_risks: data?.totalRisks ?? (data?.risks?.length ?? 0),
      critical_risks: (data?.risks || []).filter(r => r.level === "critical").length,
      _source: "rugcheck",
    };
    putCache(key, result);
    return result;
  } catch (e) {
    return { mint, indexed: false, error: e.message, _source: "rugcheck" };
  }
}

// ─── Integration: convert RugCheck score → Ponyou rug signal ─────

/**
 * Convert a RugCheck report into Ponyou-compatible rug signals.
 * Merges with existing signals — RugCheck is additive, not replacement.
 */
export function rugCheckToSignals(report) {
  if (!report?.indexed) return {};

  const signals = {
    _rugcheck_score: report.rug_score_rugcheck || report.rug_score || 0,
    _rugcheck_verified: report.verified || false,
    _rugcheck_risks: report.risks?.length || 0,
  };

  // Map RugCheck findings to our known signal fields.
  // Design: additive only — RugCheck enriches, never clears.
  // If a previous layer set freeze_authority=true, we don't
  // want RugCheck to overwrite it to false just because it
  // didn't detect it.
  if (report.freeze_authority) signals.freeze_authority = report.freeze_authority;
  if (report.mint_authority) signals.mint_authority = report.mint_authority;
  if (report.lp_locked === false && report.lp_burned === false) {
    signals.lp_locked = false;
  }
  if (report.top10_concentration_pct > 60) {
    signals.supply_concentrated = true;
  }

  return signals;
}

// ─── Batch Pre-Screening for Trash Filter ───────────────────────

/**
 * Batch-check tokens via RugCheck summary API.
 * Returns a quick score per token for the trash filter's outermost layer.
 *
 * @param {Array} tokens — array of { mint, symbol }
 * @returns {Map<string, { score: number, critical: number, risks: number, indexed: boolean }>}
 */
export async function rugCheckBatchScreen(tokens) {
  const results = new Map();

  // Cap at 10 parallel to avoid rate-limiting the free API
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 8) {
    chunks.push(tokens.slice(i, i + 8));
  }

  for (const chunk of chunks) {
    const batch = await Promise.all(
      chunk.map(async (t) => {
        const summary = await getRugCheckSummary(t.mint);
        return { mint: t.mint, symbol: t.symbol, summary };
      })
    );

    for (const { mint, symbol, summary } of batch) {
      if (!summary?.indexed) {
        results.set(mint, { score: 0, critical: 0, risks: 0, indexed: false });
        continue;
      }

      results.set(mint, {
        score: summary.rug_score || 0,
        critical: summary.critical_risks || 0,
        risks: summary.total_risks || 0,
        indexed: true,
      });
    }
  }

  return results;
}

// ─── Cache helpers ─────────────────────────────────────────────

export function clearRugCheckCache() {
  _cache.clear();
}

export function getRugCheckCacheSize() {
  return _cache.size;
}
