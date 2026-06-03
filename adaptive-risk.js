/**
 * adaptive-risk.js — intra-session position sizing throttle.
 *
 * Stateless: derives risk level from existing in-memory state (consecutive
 * losses, session P&L, rug circuit breaker, market condition). Never persists,
 * never fetches, sub-millisecond. Clamps deployAmount before the executor —
 * the LLM cannot argue out of it.
 *
 * Multiplier ladder (composed by min(), never fights Kelly):
 *   circuit locked          → 0.00 (skip cycle entirely)
 *   consecutiveLosses ≥ 3   → 0.40
 *   consecutiveLosses ≥ 2   → 0.60
 *   sessionPnl ≤ −20%       → 0.50
 *   sessionPnl ≤ −10%       → 0.75
 *   recent rugRate ≥ 30%    → 0.50
 *   house money (+30%+)     → 1.25 (cap at maxMultiplier)
 *   else                    → 1.00
 */

/**
 * Compute a risk multiplier and level from session state.
 * All inputs have safe defaults so partial state is fine.
 *
 * @param {object} state
 * @param {number} state.consecutiveLosses
 * @param {number} state.sessionPnlPct       (today's P&L %)
 * @param {boolean} state.circuitLocked       (rug circuit breaker tripped)
 * @param {number} state.rugRateRecent        (0-1, fraction of recent exits that were rugs)
 * @param {string} state.marketCondition
 * @param {number} state.openRatio            (open positions / max positions)
 * @param {object} [opts]
 * @param {number} [opts.maxMultiplier=1.25]
 * @returns {{ multiplier: number, level: string, reason: string }}
 */
export function getRiskMultiplier({
  consecutiveLosses = 0,
  sessionPnlPct     = 0,
  circuitLocked     = false,
  rugRateRecent     = 0,
  marketCondition   = "NORMAL",
  openRatio         = 0,
} = {}, { maxMultiplier = 1.25 } = {}) {
  if (circuitLocked) {
    return { multiplier: 0, level: "CIRCUIT_LOCKED", reason: "rug_circuit_breaker_tripped" };
  }

  let multiplier = 1.0;
  const reasons  = [];

  // Loss streak
  if (consecutiveLosses >= 3) {
    multiplier = Math.min(multiplier, 0.40);
    reasons.push(`${consecutiveLosses}_consecutive_losses`);
  } else if (consecutiveLosses >= 2) {
    multiplier = Math.min(multiplier, 0.60);
    reasons.push(`${consecutiveLosses}_consecutive_losses`);
  }

  // Session drawdown
  if (sessionPnlPct <= -20) {
    multiplier = Math.min(multiplier, 0.50);
    reasons.push("session_drawdown_20pct");
  } else if (sessionPnlPct <= -10) {
    multiplier = Math.min(multiplier, 0.75);
    reasons.push("session_drawdown_10pct");
  }

  // Recent rug wave
  if (rugRateRecent >= 0.30) {
    multiplier = Math.min(multiplier, 0.50);
    reasons.push("rug_wave_30pct");
  }

  // Dead market — don't compound losses in unproductive conditions
  if (marketCondition === "DEAD") {
    multiplier = Math.min(multiplier, 0.60);
    reasons.push("market_dead");
  }

  // House money boost (session well in profit)
  if (sessionPnlPct >= 30 && multiplier === 1.0) {
    multiplier = Math.min(maxMultiplier, 1.25);
    reasons.push("house_money_30pct_up");
  }

  const level = multiplier === 0        ? "CIRCUIT_LOCKED"
    : multiplier <= 0.45  ? "DEFENSIVE_CRITICAL"
    : multiplier <= 0.65  ? "DEFENSIVE"
    : multiplier <= 0.80  ? "CAUTIOUS"
    : multiplier === 1.0  ? "NORMAL"
    : "AGGRESSIVE";

  return {
    multiplier: Number(multiplier.toFixed(3)),
    level,
    reason: reasons.join("+") || "normal",
  };
}

/**
 * Clamp a SOL deploy amount using session risk state.
 * Returns the adjusted amount + risk metadata.
 *
 * @param {number} amountSol
 * @param {object} sessionState  (see getRiskMultiplier)
 * @param {object} [opts]
 * @param {number} [opts.minSol=0]         floor (never return below this)
 * @param {number} [opts.maxMultiplier=1.25]
 * @returns {{ amount_sol, multiplier, level, reason }}
 */
export function adaptDeployAmount(amountSol, sessionState = {}, { minSol = 0, maxMultiplier = 1.25 } = {}) {
  const risk      = getRiskMultiplier(sessionState, { maxMultiplier });
  const rawAmount = Number(amountSol) || 0;
  const adjusted  = risk.multiplier === 0 ? 0 : Math.max(minSol, rawAmount * risk.multiplier);
  return {
    amount_sol: Number(adjusted.toFixed(4)),
    ...risk,
  };
}

/**
 * Build a compact prompt status line when risk is non-normal.
 * Returns null in NORMAL state to keep prompts short for weak models.
 */
export function getAdaptiveRiskPromptLine(sessionState = {}, opts = {}) {
  const risk = getRiskMultiplier(sessionState, opts);
  if (risk.level === "NORMAL") return null;
  if (risk.multiplier === 0) {
    return `[RISK STATE] level=CIRCUIT_LOCKED — JANGAN ENTRY. Tunggu cooldown.`;
  }
  return `[RISK STATE] level=${risk.level} reason=${risk.reason} size_factor=${risk.multiplier} — entry kecil saja, tunggu setup A+`;
}
