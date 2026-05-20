import { buildRiskPolicy } from "./risk-policy.js";
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function evaluateCandidateDecision({
  token = {},
  conviction = {},
  marketCondition = "UNKNOWN",
  probeSizeFraction = 0.35,
  policy: policyOverride = null,
  config = {},
} = {}) {
  const normalMarket = String(marketCondition || "UNKNOWN").toUpperCase().trim();
  const convictionScore = Number(conviction.conviction_score || 0);
  const convictionConfidence = Number(conviction.confidence_score || 0);
  const policy = policyOverride || buildRiskPolicy({
    marketCondition: normalMarket,
    conviction,
    token,
    config,
  });
  if (token.rug_score == null || !Number.isFinite(Number(token.rug_score))) {
    return { verdict: "skip", reason: "missing_rug_score", caution: 100 };
  }
  const reasons = [];
  let cautionScore = 0;

  const flagCount = Array.isArray(token.flags) ? token.flags.length : 0;
  const criticalFlags = Array.isArray(token.flags)
    ? token.flags.filter(f => {
      if (typeof f === "string") return false;
      return f?.severity === "critical" || f?.severity === "high";
    })
    : [];
  if (criticalFlags.length >= 1) {
    cautionScore += 50;
    reasons.push(`critical_flag:${criticalFlags[0]?.type || "unknown"}`);
  }
  if (flagCount === 1 && criticalFlags.length === 0) {
    cautionScore += 12;
    reasons.push("single_flag");
  }
  if (flagCount >= 2) {
    cautionScore += 24;
    reasons.push(`flags=${flagCount}`);
  }
  if ((token.rug_score || 0) >= policy.entry.hardBlockRugScore) {
    cautionScore += 45;
    reasons.push(`rug_score=${token.rug_score}`);
  } else if ((token.rug_score || 0) >= 20) {
    cautionScore += 25;
    reasons.push(`rug_score=${token.rug_score}`);
  }
  if (token.kelly?.should_skip) {
    cautionScore += 40;
    reasons.push("negative_kelly_edge");
  }
  if (token.momentum_entry_pass === false) {
    cautionScore += 10;
    reasons.push("momentum_unconfirmed");
  }
  if (normalMarket === "COLD") {
    cautionScore += 8;
    reasons.push("cold_market");
  }
  if (normalMarket === "DEAD") {
    cautionScore += 20;
    reasons.push("dead_market");
  }
  if (convictionConfidence < policy.entry.shadowConfidenceFloor) {
    cautionScore += 16;
    reasons.push("low_conviction_confidence");
  }
  if (convictionScore < 35) {
    cautionScore += 14;
    reasons.push("weak_conviction");
  }
  const canConvictionReduce = !(
    (token.rug_score || 0) >= 20 ||
    criticalFlags.length >= 1 ||
    token.kelly?.should_skip === true
  );
  if (canConvictionReduce && convictionScore >= 70 && convictionConfidence >= 45) {
    cautionScore -= 12;
    reasons.push("strong_conviction");
  }

  cautionScore = clamp(cautionScore, 0, 100);

  let verdict = "active";
  let sizeMultiplier = 1;
  if (token.kelly?.should_skip || normalMarket === "DEAD" || cautionScore >= 45 || (token.rug_score || 0) >= policy.entry.hardBlockRugScore) {
    verdict = "skip";
    sizeMultiplier = 0;
  } else if (convictionConfidence < policy.entry.shadowConfidenceFloor || convictionScore < 35) {
    verdict = "shadow";
    sizeMultiplier = 0;
  } else if (
    cautionScore >= policy.entry.probeCautionThreshold ||
    convictionScore < 65 ||
    convictionConfidence < policy.entry.activeConfidenceFloor ||
    convictionConfidence < (policy.entry.probeConfidenceFloor ?? 0)
  ) {
    verdict = "probe";
    sizeMultiplier = Math.min(policy.sizing.probeSizeFraction, probeSizeFraction);
  }

  return {
    verdict,
    caution_score: cautionScore,
    reasons,
    policy,
    size_multiplier: Number(sizeMultiplier.toFixed(4)),
    recommended_amount_sol: Number(((token.volatility_adjusted_size || 0) * sizeMultiplier).toFixed(4)),
    fast_track_eligible: verdict === "active" && cautionScore <= 18 && flagCount === 0 && token.momentum_entry_pass !== false,
    llm_can_buy: verdict === "probe" || verdict === "active",
  };
}
