/**
 * DayPhaseAnalyzer
 * Identifies memecoins in cooldown→sideways accumulation phase for 3–7 day swing entries.
 * Pure analysis layer — never executes trades, never emits buy/sell signals.
 * Requires >= 1 SOL wallet balance to unlock (isDayPhaseTradeUnlocked gate).
 */

export const DayPhase = Object.freeze({
  HYPE: "HYPE",
  PARABOLIC: "PARABOLIC",
  COOLDOWN_SIDEWAYS: "COOLDOWN_SIDEWAYS",
  REVIVAL_DEATH: "REVIVAL_DEATH",
});

export const WatchlistStatus = Object.freeze({
  STRONG: "STRONG",
  MEDIUM: "MEDIUM",
  WEAK: "WEAK",
  SKIP: "SKIP",
});

/**
 * @typedef {object} DayPhaseInput
 * @property {number} [walletBalanceSol] Current wallet balance in SOL.
 * @property {number} [currentPrice] Current token price in USD.
 * @property {number} [athPrice] All-time high price in USD.
 * @property {number} [sidewaysDays] Days token has been in low-volatility range.
 * @property {number} [fdvUsd] Fully diluted valuation in USD.
 * @property {number} [socialScore] Social/community activity score (0–100).
 * @property {number} [volumeToday] 24h volume today in USD.
 * @property {number} [volumeYesterday] 24h volume yesterday in USD.
 * @property {number} [volumeDayBefore] 24h volume two days ago in USD.
 * @property {string} [entryDayOfWeek] Day of week for entry timing ("Mon"–"Sun").
 */

/**
 * @typedef {object} ScoreBreakdown
 * @property {number} dipDepth Points from dip depth criterion (0–25).
 * @property {number} sidewaysDuration Points from sideways duration (0–20).
 * @property {number} fdv Points from FDV threshold (0–20).
 * @property {number} narrativeAlive Points from social score (0–20).
 * @property {number} volumeTrend Points from volume trend (0–15).
 * @property {number} total Total score (0–100).
 */

/**
 * @typedef {object} ExecutionPlan
 * @property {string[]} dcaTranches Entry tranche descriptions (e.g., ["33% Friday", "33% Saturday", "34% Sunday"]).
 * @property {number} tp1Percent Take-profit 1 target (% gain from entry).
 * @property {number} tp2Percent Take-profit 2 target (% gain from entry).
 * @property {number} tp1ExitPercent Percent of position to exit at TP1.
 * @property {number} tp2ExitPercent Percent of remaining position to exit at TP2.
 * @property {number} maxHoldDays Maximum holding period in days.
 * @property {number} invalidationDropPercent Exit if price drops this % from entry.
 * @property {boolean} weekendBias Whether entry timing is weekend-biased.
 */

/**
 * @typedef {object} DayPhaseOutput
 * @property {boolean} isDirectBuySignal Always false.
 * @property {boolean} isUnlocked Whether balance gate passed.
 * @property {number} score Total score (0–100).
 * @property {ScoreBreakdown} scoreBreakdown Per-criterion breakdown.
 * @property {string} dayPhase DayPhase enum value.
 * @property {string} watchlistStatus WatchlistStatus enum value.
 * @property {string[]} reasons Human-readable explanations.
 * @property {ExecutionPlan|null} executionPlan Plan for STRONG/MEDIUM tokens; null otherwise.
 */

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Balance gate — skill only usable when wallet has >= 1 SOL.
 * @param {number} walletBalanceSol
 * @returns {boolean}
 */
export function isDayPhaseTradeUnlocked(walletBalanceSol) {
  return number(walletBalanceSol, 0) >= 1;
}

/**
 * Criterion 1: Dip depth from ATH (0–25 pts).
 * Sweet spot: 50–70% dip.
 */
function scoreDipDepth(currentPrice, athPrice, reasons) {
  const current = number(currentPrice, 0);
  const ath = number(athPrice, 0);

  if (ath <= 0 || current <= 0) {
    reasons.push("Dip depth: missing ATH or price data (0 pts)");
    return 0;
  }

  const dipPct = ((ath - current) / ath) * 100;

  if (dipPct >= 50 && dipPct <= 70) {
    reasons.push(`Dip depth: ${dipPct.toFixed(1)}% — sweet spot 50–70% (25 pts)`);
    return 25;
  }
  if ((dipPct >= 40 && dipPct < 50) || (dipPct > 70 && dipPct <= 80)) {
    reasons.push(`Dip depth: ${dipPct.toFixed(1)}% — near sweet spot (15 pts)`);
    return 15;
  }
  if ((dipPct >= 30 && dipPct < 40) || (dipPct > 80 && dipPct <= 90)) {
    reasons.push(`Dip depth: ${dipPct.toFixed(1)}% — marginal (5 pts)`);
    return 5;
  }
  reasons.push(`Dip depth: ${dipPct.toFixed(1)}% — outside scoring range (0 pts)`);
  return 0;
}

/**
 * Criterion 2: Sideways duration in days (0–20 pts).
 * Optimal: 3–5 days.
 */
function scoreSidewaysDuration(sidewaysDays, reasons) {
  const days = number(sidewaysDays, 0);

  if (days >= 3 && days <= 5) {
    reasons.push(`Sideways: ${days}d — optimal 3–5 days (20 pts)`);
    return 20;
  }
  if (days >= 6 && days <= 7) {
    reasons.push(`Sideways: ${days}d — extended but still valid (15 pts)`);
    return 15;
  }
  if (days >= 1 && days <= 2) {
    reasons.push(`Sideways: ${days}d — too early to confirm (5 pts)`);
    return 5;
  }
  if (days > 7) {
    reasons.push(`Sideways: ${days}d — stale / dead range (0 pts)`);
    return 0;
  }
  reasons.push("Sideways: no consolidation detected (0 pts)");
  return 0;
}

/**
 * Criterion 3: FDV threshold (0–20 pts).
 */
function scoreFdv(fdvUsd, reasons) {
  const fdv = number(fdvUsd, 0);

  if (fdv > 1_000_000) {
    reasons.push(`FDV: $${(fdv / 1_000_000).toFixed(2)}M — above $1M threshold (20 pts)`);
    return 20;
  }
  if (fdv > 500_000) {
    reasons.push(`FDV: $${(fdv / 1000).toFixed(0)}k — marginal ($500k–$1M) (10 pts)`);
    return 10;
  }
  reasons.push(`FDV: $${(fdv / 1000).toFixed(0)}k — too low, skip (0 pts)`);
  return 0;
}

/**
 * Criterion 4: Narrative alive via social score (0–20 pts).
 */
function scoreNarrativeAlive(socialScore, reasons) {
  const score = clamp(number(socialScore, 0), 0, 100);

  if (score >= 70) {
    reasons.push(`Narrative: social score ${score} — community active (20 pts)`);
    return 20;
  }
  if (score >= 50) {
    reasons.push(`Narrative: social score ${score} — moderate activity (10 pts)`);
    return 10;
  }
  reasons.push(`Narrative: social score ${score} — community quiet (0 pts)`);
  return 0;
}

/**
 * Criterion 5: Volume trend (0–15 pts).
 * Stabilizing or slight uptick from bottom preferred.
 */
function scoreVolumeTrend(volumeToday, volumeYesterday, volumeDayBefore, reasons) {
  const today = number(volumeToday, 0);
  const yesterday = number(volumeYesterday, 0);
  const dayBefore = number(volumeDayBefore, 0);

  if (today <= 0 || yesterday <= 0) {
    reasons.push("Volume trend: insufficient data (0 pts)");
    return 0;
  }

  // Uptick: today >= yesterday >= dayBefore (or dayBefore unknown)
  if (today >= yesterday && (dayBefore <= 0 || yesterday >= dayBefore)) {
    reasons.push("Volume trend: uptick — accumulation signal (15 pts)");
    return 15;
  }

  // Stabilizing: today within ±10% of yesterday
  const ratio = today / yesterday;
  if (ratio >= 0.9 && ratio < 1.0) {
    reasons.push("Volume trend: stabilizing (10 pts)");
    return 10;
  }

  // Declining but not dead: today >= 50% of yesterday
  if (today >= yesterday * 0.5) {
    reasons.push("Volume trend: declining but not dead (5 pts)");
    return 5;
  }

  reasons.push("Volume trend: sharply declining (0 pts)");
  return 0;
}

/**
 * Classify the DayPhase enum from score + input signals.
 */
function classifyDayPhase(score, dipPct, sidewaysDays) {
  if (dipPct !== null && dipPct < 20) return DayPhase.HYPE;
  if (dipPct !== null && dipPct < 40 && sidewaysDays < 2) return DayPhase.PARABOLIC;
  if (dipPct !== null && dipPct > 85) return DayPhase.REVIVAL_DEATH;
  if (score >= 55) return DayPhase.COOLDOWN_SIDEWAYS;
  if (sidewaysDays > 7) return DayPhase.REVIVAL_DEATH;
  return DayPhase.HYPE;
}

/**
 * Build execution plan for STRONG/MEDIUM tokens.
 * @param {string} watchlistStatus
 * @param {string} [entryDayOfWeek]
 * @returns {ExecutionPlan|null}
 */
function buildExecutionPlan(watchlistStatus, entryDayOfWeek) {
  if (watchlistStatus === WatchlistStatus.WEAK || watchlistStatus === WatchlistStatus.SKIP) {
    return null;
  }

  const day = String(entryDayOfWeek ?? "").toLowerCase();
  const weekendDays = ["fri", "sat", "sun", "friday", "saturday", "sunday"];
  const isWeekend = weekendDays.some(d => day.startsWith(d.slice(0, 3)));

  let dcaTranches;
  if (isWeekend) {
    dcaTranches = ["50% now (weekend entry)", "50% next dip within 48h"];
  } else {
    dcaTranches = ["33% today", "33% Friday", "34% Saturday"];
  }

  return {
    dcaTranches,
    tp1Percent: 40,
    tp2Percent: 70,
    tp1ExitPercent: 40,
    tp2ExitPercent: 70,
    maxHoldDays: 7,
    invalidationDropPercent: 15,
    weekendBias: !isWeekend,
  };
}

/**
 * Main entry point — analyzes a token's phase suitability for 3–7 day swing entry.
 * @param {DayPhaseInput} input
 * @returns {DayPhaseOutput}
 */
export function analyzeDayPhase(input = {}) {
  const walletBalanceSol = number(input.walletBalanceSol, 0);
  const isUnlocked = isDayPhaseTradeUnlocked(walletBalanceSol);

  if (!isUnlocked) {
    return {
      isDirectBuySignal: false,
      isUnlocked: false,
      score: 0,
      scoreBreakdown: { dipDepth: 0, sidewaysDuration: 0, fdv: 0, narrativeAlive: 0, volumeTrend: 0, total: 0 },
      dayPhase: DayPhase.HYPE,
      watchlistStatus: WatchlistStatus.SKIP,
      reasons: [`Balance gate locked: ${walletBalanceSol.toFixed(3)} SOL < 1 SOL required`],
      executionPlan: null,
    };
  }

  const reasons = [];

  const dipDepth = scoreDipDepth(input.currentPrice, input.athPrice, reasons);
  const sidewaysDuration = scoreSidewaysDuration(input.sidewaysDays, reasons);
  const fdv = scoreFdv(input.fdvUsd, reasons);
  const narrativeAlive = scoreNarrativeAlive(input.socialScore, reasons);
  const volumeTrend = scoreVolumeTrend(input.volumeToday, input.volumeYesterday, input.volumeDayBefore, reasons);

  const total = dipDepth + sidewaysDuration + fdv + narrativeAlive + volumeTrend;
  const scoreBreakdown = { dipDepth, sidewaysDuration, fdv, narrativeAlive, volumeTrend, total };

  // Compute dipPct for phase classification
  const current = number(input.currentPrice, 0);
  const ath = number(input.athPrice, 0);
  const dipPct = ath > 0 && current > 0 ? ((ath - current) / ath) * 100 : null;
  const sidewaysDays = number(input.sidewaysDays, 0);

  const dayPhase = classifyDayPhase(total, dipPct, sidewaysDays);

  let watchlistStatus;
  if (total >= 75) watchlistStatus = WatchlistStatus.STRONG;
  else if (total >= 55) watchlistStatus = WatchlistStatus.MEDIUM;
  else if (total >= 35) watchlistStatus = WatchlistStatus.WEAK;
  else watchlistStatus = WatchlistStatus.SKIP;

  const executionPlan = buildExecutionPlan(watchlistStatus, input.entryDayOfWeek);

  return {
    isDirectBuySignal: false,
    isUnlocked: true,
    score: total,
    scoreBreakdown,
    dayPhase,
    watchlistStatus,
    reasons,
    executionPlan,
  };
}
