/**
 * Strategy Matcher — Per-coin strategy fit scoring
 *
 * For each candidate token that lulus screening, score it against every
 * strategy preset's filter window. Returns the best-matching strategy so
 * pro-orchestrator can dispatch the entry under that strategy's params
 * (entry size, ROI ladder, stoploss, trailing) rather than under the
 * globally-active strategy.
 *
 * Scoring model (per strategy):
 *   1. HARD GATES — token must fall within the strategy's filter window.
 *      Any breach → score = 0 (this strategy is not a viable host).
 *   2. WINDOW FIT — within-window position. A token whose mcap sits near
 *      the centre of the strategy's mcap band scores higher than one near
 *      either edge.
 *   3. SIGNAL ALIGNMENT — bonuses for trait/narrative matches:
 *      - smart_money preset: bonus if smart wallets are present
 *      - dip_buy preset: bonus if currently below ATH meaningfully
 *      - day_phase_trading: bonus if in sideways regime + dipped
 *      - scalping: bonus if hot launch, fresh pair
 *      - sniper: bonus if low fees, low mcap, tight window
 *      - degen: residual fallback — always positive small score so it
 *        catches tokens that don't fit anything else
 *
 * Anti-thrashing: caller is expected to compare score against the active
 * strategy's score. We only suggest override when the margin is > 0.15
 * — small wins aren't worth the management complexity of running two
 * strategies in parallel.
 */
import { PRESETS } from "../strategies.js";

const PRESET_IDS = Object.keys(PRESETS);

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function tokenMcap(token) {
  return Number(token?.fdv_usd ?? token?.mcap_usd ?? token?.fdv ?? token?.market_cap ?? 0);
}

function tokenHolders(token) {
  return Number(token?.holders ?? token?.holder_count ?? token?.holders_count ?? 0);
}

function tokenTop10Pct(token) {
  return Number(token?.top10_concentration_pct ?? token?.topHolders?.top10_pct ?? token?.top10_pct ?? 0);
}

function tokenAgeHours(token) {
  return Number(token?.holder_age_hours ?? token?.age_hours ?? token?.token_age_hours ?? 0);
}

function tokenAthDistancePct(token) {
  // Negative number — how far below ATH (e.g. -40 = 40% below ATH).
  const raw = token?.ath_distance_pct ?? token?.distance_from_ath_pct ?? token?.ath_drawdown_pct;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function tokenSmartHolders(token) {
  return Number(token?.smart_money?.holders ?? (token?.smart_holders?.length ?? 0));
}

function tokenHotness(token) {
  // Heuristic — fresh pair indicators
  const ageH = tokenAgeHours(token);
  if (ageH > 0 && ageH < 12) return 1;
  if (ageH > 0 && ageH < 48) return 0.5;
  return 0;
}

/**
 * Window-fit score: 1 when value sits near the centre of [lo, hi],
 * tapering to 0 at the edges. Returns 0.5 if either bound is missing
 * (mild signal). Returns 0 if outside the window.
 */
function windowFit(value, lo, hi) {
  if (!Number.isFinite(value)) return 0;
  const hasLo = Number.isFinite(lo) && lo > 0;
  const hasHi = Number.isFinite(hi) && hi > 0;
  if (!hasLo && !hasHi) return 0.5;
  if (hasLo && value < lo) return 0;
  if (hasHi && value > hi) return 0;
  if (hasLo && hasHi) {
    // Bell-shaped — score peaks at midpoint
    const mid = (lo + hi) / 2;
    const halfRange = (hi - lo) / 2;
    if (halfRange <= 0) return 0.5;
    const dist = Math.abs(value - mid) / halfRange;
    return clamp01(1 - dist);
  }
  return 0.7; // one-sided bound — token is in valid range, give partial credit
}

/**
 * Check hard filter gates. Returns false if any required filter window
 * excludes the token. Filters tested are the ones that meaningfully gate
 * entry — softer config knobs (flags, fees) are not checked here since
 * those are decision-time policy, not coin fit.
 */
function passesHardGates(token, filters) {
  if (!filters) return true;
  const mcap = tokenMcap(token);
  if (filters.min_mcap_usd != null && mcap > 0 && mcap < filters.min_mcap_usd) return false;
  if (filters.max_mcap_usd != null && mcap > 0 && mcap > filters.max_mcap_usd) return false;
  if (filters.min_holders != null && tokenHolders(token) > 0 && tokenHolders(token) < filters.min_holders) return false;
  if (filters.max_top10_pct != null && tokenTop10Pct(token) > 0 && tokenTop10Pct(token) > filters.max_top10_pct) return false;
  if (filters.minHolderAgeHours != null && tokenAgeHours(token) > 0 && tokenAgeHours(token) < filters.minHolderAgeHours) return false;
  if (filters.max_ath_distance_pct != null) {
    // max_ath_distance_pct is negative (e.g. -40 = at least 40% below ATH required).
    // Token's ath distance must be <= the threshold (more negative = deeper dip).
    const ath = tokenAthDistancePct(token);
    if (ath > filters.max_ath_distance_pct) return false;
  }
  return true;
}

/**
 * Compute a per-strategy fit score in [0, 1].
 * Returns { score, reasons } where reasons[] explains the contributing
 * factors so the caller can log why a particular strategy was selected.
 */
function scoreStrategy(strategyId, preset, token, ctx = {}) {
  const filters = preset.filters || {};
  const reasons = [];

  if (!passesHardGates(token, filters)) {
    return { score: 0, reasons: ["hard-filter excluded"] };
  }

  let score = 0;
  let weight = 0;

  // Window fit — mcap and holders
  const mcap = tokenMcap(token);
  if (mcap > 0 && (filters.min_mcap_usd != null || filters.max_mcap_usd != null)) {
    const fit = windowFit(mcap, filters.min_mcap_usd, filters.max_mcap_usd);
    score += fit * 0.35;
    weight += 0.35;
    if (fit > 0.7) reasons.push(`mcap fits centre (${fit.toFixed(2)})`);
  }
  const holders = tokenHolders(token);
  if (holders > 0 && filters.min_holders != null) {
    // For holders, "more is better" within the strategy that demands holders.
    const ratio = Math.min(1, holders / (filters.min_holders * 2));
    score += ratio * 0.20;
    weight += 0.20;
    if (ratio > 0.7) reasons.push(`holders=${holders} (≥${filters.min_holders})`);
  }

  // Per-strategy signal-alignment bonuses — each preset has a "shape" of
  // token it's actually designed to catch. These are weighted small enough
  // that they tilt ties, not flip clear losers.
  if (strategyId === "smart_money") {
    const sm = tokenSmartHolders(token);
    if (sm >= 2) { score += 0.25; weight += 0.25; reasons.push(`smart-money present (${sm})`); }
    else weight += 0.25;
  } else if (strategyId === "dip_buy") {
    const ath = tokenAthDistancePct(token);
    if (ath <= -30) { score += 0.20; weight += 0.20; reasons.push(`dipped ${ath}% from ATH`); }
    else weight += 0.20;
  } else if (strategyId === "day_phase_trading") {
    const regime = String(ctx.marketCondition || "").toUpperCase();
    const ath = tokenAthDistancePct(token);
    if ((regime === "COLD" || regime === "NORMAL") && ath <= -50) {
      score += 0.25; weight += 0.25; reasons.push(`swing setup: regime=${regime}, ath=${ath}%`);
    } else weight += 0.25;
  } else if (strategyId === "scalping") {
    const h = tokenHotness(token);
    if (h > 0) { score += 0.15 * h; reasons.push(`hot launch (${h.toFixed(2)})`); }
    weight += 0.15;
  } else if (strategyId === "sniper") {
    // Sniper favours very small mcap, very fresh tokens
    const ageH = tokenAgeHours(token);
    const ageBonus = ageH > 0 && ageH < 24 ? 0.20 : 0;
    if (ageBonus > 0) { score += ageBonus; reasons.push(`fresh: ${ageH}h`); }
    weight += 0.20;
  } else if (strategyId === "degen") {
    // Residual fallback — always small positive so degen catches
    // misfits that no other strategy claims. Caller decides whether
    // to actually accept degen based on margin.
    score += 0.1;
    weight += 0.1;
    reasons.push("degen residual");
  }

  const normalized = weight > 0 ? clamp01(score / weight) : 0;
  return { score: normalized, reasons };
}

/**
 * Main entry — match a token to its best-fit strategy.
 *
 * @param {Object} args
 * @param {Object} args.token              Token candidate
 * @param {string} args.activeStrategyId   Currently active global strategy
 * @param {string} args.marketCondition    Current regime (HOT/NORMAL/COLD/etc.)
 * @param {number} args.overrideMargin     Minimum score advantage required to
 *                                         suggest overriding the active strategy.
 *                                         Default 0.15 (15 points absolute).
 * @returns {{
 *   best:       { id, score, reasons } | null,
 *   active:     { id, score, reasons },
 *   all:        Array<{ id, score, reasons }>,
 *   suggest_override: boolean,
 *   selected_strategy: string,
 * }}
 */
export function matchStrategyForCoin({
  token,
  activeStrategyId,
  marketCondition = "NORMAL",
  overrideMargin = 0.15,
} = {}) {
  const ctx = { marketCondition };
  const all = PRESET_IDS.map((id) => {
    const { score, reasons } = scoreStrategy(id, PRESETS[id], token, ctx);
    return { id, score, reasons };
  }).sort((a, b) => b.score - a.score);

  const best = all[0];
  const active = all.find((s) => s.id === activeStrategyId) || null;
  const activeScore = active?.score ?? 0;

  // Only suggest override when best is strictly better than active by margin.
  // Tie + match against active → keep active (avoid churn).
  const suggestOverride = best && best.id !== activeStrategyId && (best.score - activeScore) >= overrideMargin;

  return {
    best,
    active: active || { id: activeStrategyId, score: 0, reasons: ["active not scored"] },
    all,
    suggest_override: Boolean(suggestOverride),
    selected_strategy: suggestOverride ? best.id : activeStrategyId,
  };
}
