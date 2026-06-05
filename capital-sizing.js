import { computeFractionalKellySize } from "./kelly.js";
import { normalizeRegime, REGIMES, isTradingAllowed } from "./market-regime.js";
import { selectKellyMode } from "./kelly-mode-selector.js";

const DEFAULT_CAPITAL_SIZING = {
  microThreshold: 50,
  fullThreshold: 200,
  microFlat: { HOT: 0.15, WARM: 0.08, NORMAL: 0.08 },
  growthCap: 0.20,
  growthFallbackFraction: 0.10,
};

export function getCapitalAwareSizing({
  bankrollSol = 0,
  solPriceUsd = 0,
  baseDeployAmountSol = 0,
  trades = [],
  context = {},
  regime = "WARM",
  fraction = 0.5,
  minFraction = 0.1,
  maxFraction = 0.8,
  minSampleTrades = 5,
  capitalSizing = {},
  kellyModeOpts = null,
} = {}) {
  if (!solPriceUsd || solPriceUsd <= 0) {
    return { should_skip: true, reason: "sol_price_unavailable", tier: "UNKNOWN", deploy_amount_sol: 0 };
  }

  if (!bankrollSol || bankrollSol <= 0) {
    return { should_skip: true, reason: "zero_bankroll", tier: "UNKNOWN", deploy_amount_sol: 0 };
  }

  const marketCondition = normalizeRegime(regime);
  const cfg = {
    ...DEFAULT_CAPITAL_SIZING,
    ...capitalSizing,
    microFlat: { ...DEFAULT_CAPITAL_SIZING.microFlat, ...(capitalSizing?.microFlat || {}) },
  };
  const capitalUsd = (bankrollSol || 0) * (solPriceUsd || 0);

  // ── MICRO tier ──────────────────────────────────────────────────────────────
  if (capitalUsd < cfg.microThreshold) {
    if (marketCondition === REGIMES.EXTREME) {
      return {
        deploy_amount_sol: 0,
        kelly_fraction: 0,
        effective_fraction: 0,
        inputs: {},
        used_fallback: true,
        should_skip: true,
        tier: "MICRO",
        method: "regime-flat",
        capital_usd: capitalUsd,
        capped_at: null,
      };
    }
    const flatFraction = (cfg.microFlat || {})[marketCondition] ?? null;
    if (flatFraction === null) {
      return {
        deploy_amount_sol: 0,
        kelly_fraction: 0,
        effective_fraction: 0,
        inputs: {},
        used_fallback: true,
        should_skip: true,
        tier: "MICRO",
        method: "regime-flat",
        capital_usd: capitalUsd,
        capped_at: null,
      };
    }
    // CS-2: previously `baseDeployAmountSol > 0 ? baseDeployAmountSol : Infinity`
    // — an operator who set baseDeployAmountSol=0 (e.g. to disable trading)
    // would inadvertently uncap sizing. Treat 0/falsy as "no explicit cap"
    // but still enforce a hard ceiling at the regime-flat fraction itself,
    // so the unbounded path is impossible.
    const cap = baseDeployAmountSol > 0 ? baseDeployAmountSol : bankrollSol * flatFraction;
    const deployAmount = Number(
      Math.min(bankrollSol * flatFraction, cap).toFixed(4)
    );
    return {
      deploy_amount_sol: deployAmount,
      kelly_fraction: 0,
      effective_fraction: flatFraction,
      inputs: {},
      used_fallback: false,
      should_skip: false,
      tier: "MICRO",
      method: "regime-flat",
      capital_usd: capitalUsd,
      capped_at: null,
    };
  }

  const isGrowth = capitalUsd < cfg.fullThreshold;

  // ── GROWTH tier — no trade history fallback ─────────────────────────────────
  if (isGrowth && (trades || []).length < minSampleTrades) {
    if (!isTradingAllowed(marketCondition) || marketCondition === REGIMES.COLD) {
      return { should_skip: true, reason: "growth_fallback_cold_or_dead", tier: "GROWTH", deploy_amount_sol: 0 };
    }

    const fallbackFraction = cfg.growthFallbackFraction;
    // CS-2: same protection in growth-tier fallback.
    const cap = baseDeployAmountSol > 0 ? baseDeployAmountSol : bankrollSol * fallbackFraction;
    const fallbackAmount = Number(
      Math.min(bankrollSol * fallbackFraction, cap).toFixed(4)
    );
    return {
      deploy_amount_sol: fallbackAmount,
      kelly_fraction: 0,
      effective_fraction: fallbackFraction,
      inputs: {},
      used_fallback: true,
      should_skip: false,
      tier: "GROWTH",
      method: "growth-fallback",
      capital_usd: capitalUsd,
      capped_at: null,
    };
  }

  // ── GROWTH tier — half-kelly with cap ───────────────────────────────────────
  // ── FULL tier — full kelly ──────────────────────────────────────────────────
  // CS-FULL-FALLBACK: same chicken-and-egg fix as GROWTH tier. Without this,
  // a fresh bot at >$200 capital can never accumulate the 5 trades needed to
  // unlock Kelly sizing — it hard-skips every candidate indefinitely.
  if (!isGrowth && (trades || []).length < minSampleTrades) {
    if (!isTradingAllowed(marketCondition) || marketCondition === REGIMES.COLD) {
      return { should_skip: true, reason: "full_fallback_cold_or_dead", tier: "FULL", deploy_amount_sol: 0 };
    }
    const fallbackFraction = cfg.growthFallbackFraction;
    const cap = baseDeployAmountSol > 0 ? baseDeployAmountSol : bankrollSol * fallbackFraction;
    const fallbackAmount = Number(Math.min(bankrollSol * fallbackFraction, cap).toFixed(4));
    return {
      deploy_amount_sol: fallbackAmount,
      kelly_fraction: 0,
      effective_fraction: fallbackFraction,
      inputs: {},
      used_fallback: true,
      should_skip: false,
      tier: "FULL",
      method: "full-fallback",
      capital_usd: capitalUsd,
      capped_at: null,
    };
  }

  // Kelly mode: determine effective bankroll based on experience + conviction
  let effectiveBankroll = bankrollSol;
  if (kellyModeOpts) {
    const modeResult = selectKellyMode({
      bankrollSol,
      deployedSol:           kellyModeOpts.deployedSol           ?? 0,
      maxPositions:          kellyModeOpts.maxPositions           ?? 3,
      winRate:               kellyModeOpts.winRate                ?? 0,
      liveTrades:            kellyModeOpts.liveTrades             ?? 0,
      conviction:            kellyModeOpts.conviction             ?? 0,
      mode3Approved:         kellyModeOpts.mode3Approved          ?? false,
      semanticMemoryEntries: kellyModeOpts.semanticMemoryEntries  ?? 0,
    });
    effectiveBankroll = modeResult.effectiveBankroll;
  }

  const kellyFraction = isGrowth ? fraction * 0.5 : fraction;
  const kelly = computeFractionalKellySize({
    bankrollSol: effectiveBankroll,
    baseDeployAmountSol,
    trades,
    context,
    fraction: kellyFraction,
    minFraction,
    maxFraction,
    minSampleTrades,
  });

  if (!isGrowth) {
    return {
      ...kelly,
      tier: "FULL",
      method: "full-kelly",
      capital_usd: capitalUsd,
      capped_at: null,
    };
  }

  // GROWTH: apply cap
  const growthCapSol = bankrollSol * cfg.growthCap;
  const cappedAt = kelly.effective_fraction > cfg.growthCap ? kelly.effective_fraction : null;
  const finalAmount = Number(Math.min(kelly.deploy_amount_sol, growthCapSol).toFixed(4));
  return {
    ...kelly,
    deploy_amount_sol: finalAmount,
    tier: "GROWTH",
    method: "half-kelly",
    capital_usd: capitalUsd,
    capped_at: cappedAt,
  };
}
