function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculateKellyFraction({ b, p }) {
  if (!(b > 0) || !(p > 0 && p < 1)) return 0;
  const q = 1 - p;
  return (b * p - q) / b;
}

export function estimateKellyInputs(trades = [], context = {}) {
  const usable = (trades || []).filter(t => Number.isFinite(t?.pnl_pct));
  const wins = usable.filter(t => (t.pnl_pct || 0) > 0);
  const losses = usable.filter(t => (t.pnl_pct || 0) < 0);
  const sampleSize = usable.length;

  const rawWinRate = sampleSize > 0 ? wins.length / sampleSize : 0;
  const avgWinPct = average(wins.map(t => Math.abs(t.pnl_pct || 0)));
  const avgLossPct = average(losses.map(t => Math.abs(t.pnl_pct || 0)));
  const payoffRatio = avgLossPct > 0 ? avgWinPct / avgLossPct : 0;
  const cappedPayoffRatio = Math.min(payoffRatio, 5); // cap outlier moonbags

  let p = rawWinRate;
  if (context.marketCondition === "HOT") p += 0.03;
  if (context.marketCondition === "EXTREME") p -= 0.04;
  if (context.marketCondition === "COLD") p -= 0.02;
  if (context.marketCondition === "DEAD") p -= 0.1;

  if (Number.isFinite(context.tokenEdgeScore)) {
    p += clamp((context.tokenEdgeScore - 50) / 500, -0.08, 0.08);
  }
  if (context.holderStructureRisk === "HIGH") p -= 0.05;
  else if (context.holderStructureRisk === "MEDIUM") p -= 0.02;

  p = clamp(p, 0.05, 0.95);
  // Volatility dampener: reduce effective p when win/loss spread is extreme (memecoin high variance)
  const volatilitySpread = avgWinPct + avgLossPct;
  if (volatilitySpread > 200) p = clamp(p - 0.05, 0.05, 0.95);
  else if (volatilitySpread > 100) p = clamp(p - 0.02, 0.05, 0.95);
  return {
    sample_size: sampleSize,
    raw_win_rate: Number(rawWinRate.toFixed(3)),
    p: Number(p.toFixed(3)),
    b: Number(cappedPayoffRatio.toFixed(3)),
    avg_win_pct: Number(avgWinPct.toFixed(2)),
    avg_loss_pct: Number(avgLossPct.toFixed(2)),
  };
}

export function computeFractionalKellySize({
  bankrollSol,
  baseDeployAmountSol,
  trades = [],
  context = {},
  fraction = 0.5,
  minFraction = 0.1,
  maxFraction = 0.8,
  minSampleTrades = 10,
} = {}) {
  const inputs = estimateKellyInputs(trades, context);
  const rawKelly = calculateKellyFraction({ b: inputs.b, p: inputs.p });

  if (!(bankrollSol > 0) || !(baseDeployAmountSol > 0) || inputs.sample_size < minSampleTrades || !(inputs.b > 0)) {
    return {
      deploy_amount_sol: Number(baseDeployAmountSol || 0),
      kelly_fraction: 0,
      effective_fraction: 0,
      inputs,
      used_fallback: true,
      should_skip: false,
    };
  }

  if (!(rawKelly > 0)) {
    return {
      deploy_amount_sol: 0,
      kelly_fraction: Number(rawKelly.toFixed(4)),
      effective_fraction: 0,
      inputs,
      used_fallback: false,
      should_skip: true,
    };
  }

  const effectiveKelly = clamp(rawKelly * fraction, 0, maxFraction);
  // KL-2: minFraction is a tradability floor — if Kelly suggests something
  // below it, we still deploy at minFraction. That's anti-Kelly in spirit
  // (Kelly says scale DOWN when edge is thin), so we tag the result with
  // `floor_applied: true` so the caller / dashboard can see when this
  // override is active and operator can lower minFraction if the bot is
  // over-sizing on thin-edge candidates.
  const floorApplied = effectiveKelly < minFraction;
  const boundedKelly = Math.max(minFraction, effectiveKelly);
  const sized = bankrollSol * boundedKelly;
  return {
    deploy_amount_sol: Number(Math.min(baseDeployAmountSol, sized).toFixed(4)),
    kelly_fraction: Number(rawKelly.toFixed(4)),
    effective_fraction: Number(boundedKelly.toFixed(4)),
    floor_applied: floorApplied,
    raw_kelly_fraction_after_fraction: Number(effectiveKelly.toFixed(4)),
    inputs,
    used_fallback: false,
    should_skip: false,
  };
}
