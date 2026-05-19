import { computeFractionalKellySize } from "./kelly.js";

const DEFAULT_CAPITAL_SIZING = {
  microThreshold: 50,
  fullThreshold: 200,
  microFlat: { HOT: 0.15, WARM: 0.08 },
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
} = {}) {
  const cfg = {
    ...DEFAULT_CAPITAL_SIZING,
    ...capitalSizing,
    microFlat: { ...DEFAULT_CAPITAL_SIZING.microFlat, ...(capitalSizing?.microFlat || {}) },
  };
  const capitalUsd = (bankrollSol || 0) * (solPriceUsd || 0);

  // ── MICRO tier ──────────────────────────────────────────────────────────────
  if (capitalUsd < cfg.microThreshold) {
    const flatFraction = (cfg.microFlat || {})[regime] ?? null;
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
    const deployAmount = Number(
      Math.min(bankrollSol * flatFraction, baseDeployAmountSol > 0 ? baseDeployAmountSol : Infinity).toFixed(4)
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
    const fallbackFraction = cfg.growthFallbackFraction;
    const fallbackAmount = Number(
      Math.min(bankrollSol * fallbackFraction, baseDeployAmountSol > 0 ? baseDeployAmountSol : Infinity).toFixed(4)
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
  const kellyFraction = isGrowth ? fraction * 0.5 : fraction;
  const kelly = computeFractionalKellySize({
    bankrollSol,
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
