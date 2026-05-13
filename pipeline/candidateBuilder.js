/**
 * Candidate Builder Pipeline
 * Inspired by Charon (yunus-0x/charon) candidateBuilder.js
 *
 * Builds enriched candidate objects from raw token data,
 * and filters them against the active strategy parameters.
 */

import { getActiveStrategy, getMcapTier } from "../strategy.js";
import { log } from "../logger.js";

// ─── Signal Label ─────────────────────────────────────────────

/**
 * Generate a human-readable label for the signal source(s).
 */
export function signalLabel(token) {
  const sources = [];
  if (token._source_trending) sources.push("trending");
  if (token._source_graduated) sources.push("graduated");
  if (token._source_server) sources.push("signal-server");
  if (token._source_discovery) sources.push("discovery");
  if (sources.length === 0) sources.push("discovery");
  return sources.join(" + ");
}

// ─── Fee Snapshot ─────────────────────────────────────────────

/**
 * Build a structured fee distribution snapshot from token data.
 * Converts lamports to SOL and calculates holder percentages.
 */
export function buildFeeSnapshot(token) {
  const totalFees = token.global_fees_sol || token.fees_sol || 0;
  const volume = token.volume || token.volume_usd || 0;
  const feeRatio = volume > 0 ? totalFees / (volume / 200) : 0; // rough SOL price approximation

  return {
    total_sol: totalFees,
    volume_usd: volume,
    fee_to_volume_ratio: parseFloat(feeRatio.toFixed(4)),
    is_suspicious: volume > 100000 && totalFees < 5,
  };
}

// ─── ATH Distance ─────────────────────────────────────────────

/**
 * Calculate how far below ATH the current price is (percentage).
 */
export function calcAthDistance(token) {
  const currentPrice = token.price || token.current_price || 0;
  const athPrice = token.ath_price || token.all_time_high || 0;

  if (!athPrice || !currentPrice || currentPrice >= athPrice) return 0;
  return ((athPrice - currentPrice) / athPrice) * 100;
}

// ─── Filter Candidate ─────────────────────────────────────────

/**
 * Filter a candidate against the active strategy parameters.
 * Returns { pass, reasons[] }
 * Inspired by Charon's filterCandidate function.
 */
export function filterCandidate(candidate) {
  const strategy = getActiveStrategy();
  const f = strategy.filters;
  const reasons = [];

  // ── Market Cap gates ──────────────────────────────────────
  if (f.maxMcap != null && candidate.mcap > f.maxMcap) {
    reasons.push(`mcap $${(candidate.mcap / 1000).toFixed(0)}K > max $${(f.maxMcap / 1000).toFixed(0)}K`);
  }
  if (f.minMcap != null && candidate.mcap < f.minMcap) {
    reasons.push(`mcap $${(candidate.mcap / 1000).toFixed(0)}K < min $${(f.minMcap / 1000).toFixed(0)}K`);
  }

  // ── Bundle Rate gate ──────────────────────────────────────
  const bundlePct = candidate.bundle_pct || candidate.bundler_pct || 0;
  if (f.maxBundlePct != null && bundlePct > f.maxBundlePct) {
    reasons.push(`bundle ${bundlePct.toFixed(1)}% > max ${f.maxBundlePct}%`);
  }

  // ── Rug ratio gate (from trending data) ──────────────────
  const rugRatio = candidate.rug_ratio || candidate.rug_rate || 0;
  if (f.maxRugRatioTrending != null && rugRatio > f.maxRugRatioTrending) {
    reasons.push(`rug ratio ${(rugRatio * 100).toFixed(1)}% > max ${(f.maxRugRatioTrending * 100).toFixed(0)}%`);
  }

  // ── Holder concentration gate ─────────────────────────────
  const top10Pct = candidate.top10_pct || candidate.top_10_holder_pct || 0;
  if (f.maxTop10Pct != null && top10Pct > f.maxTop10Pct) {
    reasons.push(`top10 ${top10Pct.toFixed(1)}% > max ${f.maxTop10Pct}%`);
  }

  // ── ATH Distance gate (dip_buy) ───────────────────────────
  if (f.minAthDistancePct != null) {
    const dist = candidate._ath_distance_pct || calcAthDistance(candidate);
    if (dist < f.minAthDistancePct) {
      reasons.push(`ATH dist ${dist.toFixed(1)}% < min ${f.minAthDistancePct}% (not a real dip)`);
    }
  }

  // ── Source count gate (smart_money needs multi-source) ────
  if (f.minSourceCount != null) {
    const sourceCnt = candidate._source_count || 1;
    if (sourceCnt < f.minSourceCount) {
      reasons.push(`source count ${sourceCnt} < min ${f.minSourceCount}`);
    }
  }

  // ── Smart wallet exposure (smart_money strategy) ──────────
  if (f.minSmartWalletExposure != null) {
    const exposure = candidate.smart_wallet_exposure || candidate.saved_wallet_pct || 0;
    if (exposure < f.minSmartWalletExposure) {
      reasons.push(`smart wallet exposure ${(exposure * 100).toFixed(1)}% < min ${(f.minSmartWalletExposure * 100).toFixed(0)}%`);
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
  };
}

// ─── Compact for LLM ──────────────────────────────────────────

/**
 * Compact a candidate object for efficient LLM consumption.
 * Reduces token usage by stripping irrelevant fields.
 * Inspired by Charon's compactCandidateForLlm.
 */
export function compactCandidateForLlm(candidate) {
  const compact = {
    symbol: candidate.symbol,
    mint: candidate.mint,
    mcap: candidate.mcap,
    price: candidate.price || candidate.current_price,
    volume_1h: candidate.volume_1h || candidate.volume,
    holders: candidate.holders || candidate.holder_count,
    age_hours: candidate.age_hours || candidate.token_age_hours,
    signal: candidate._signal_label || signalLabel(candidate),
    tier: candidate.tier?.tier || getMcapTier(candidate.mcap)?.tier,
    rug_score: candidate.rug_score,
    filter_flags: candidate.flags,
    ath_distance_pct: candidate._ath_distance_pct,
    bundle_pct: candidate.bundle_pct || candidate.bundler_pct,
    top10_pct: candidate.top10_pct,
  };

  // Chart context if available
  if (candidate.technicals) {
    compact.rsi = candidate.technicals.rsi;
    compact.supertrend = candidate.technicals.supertrend?.trend;
  }

  // Smart wallet exposure
  if (candidate.smart_wallet_exposure != null) {
    compact.smart_wallet_pct = (candidate.smart_wallet_exposure * 100).toFixed(1) + "%";
  }

  // Remove nulls
  return Object.fromEntries(Object.entries(compact).filter(([, v]) => v != null));
}

// ─── Build Candidate ──────────────────────────────────────────

/**
 * Build a fully-enriched candidate from raw token + security data.
 * Attaches strategy filter results, signal labels, tier info, ATH distance.
 */
export function buildCandidate(token, security, gasFee, filterResult, extras = {}) {
  const athDist = calcAthDistance(token);
  const tierInfo = getMcapTier(token.mcap);
  const feeSnap = buildFeeSnapshot(token);
  const label = signalLabel(token);
  const stratFilter = filterCandidate({ ...token, _ath_distance_pct: athDist });

  return {
    ...token,
    ...extras,
    _signal_label: label,
    _ath_distance_pct: athDist,
    _fee_snapshot: feeSnap,
    _strategy_filter: stratFilter,
    tier: tierInfo,
    // 4-filter result (from run4FilterProtocol)
    passed: filterResult.passed,
    flags: filterResult.flags,
    filter_action: filterResult.action,
    filter_score: filterResult.score,
    // Source count (how many signal sources found this token)
    _source_count: countSources(token),
  };
}

function countSources(token) {
  let n = 0;
  if (token._source_trending) n++;
  if (token._source_graduated) n++;
  if (token._source_server) n++;
  if (token._source_discovery) n++;
  return Math.max(1, n);
}
