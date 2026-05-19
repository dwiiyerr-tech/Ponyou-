function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function evaluateCandidateDecision({
  token = {},
  conviction = {},
  marketCondition = "UNKNOWN",
  probeSizeFraction = 0.35,
} = {}) {
  const reasons = [];
  let cautionScore = 0;

  const flagCount = Array.isArray(token.flags) ? token.flags.length : 0;
  if (flagCount >= 2) {
    cautionScore += 24;
    reasons.push(`flags=${flagCount}`);
  }
  if ((token.rug_score || 0) >= 35) {
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
  if (marketCondition === "COLD") {
    cautionScore += 8;
    reasons.push("cold_market");
  }
  if (marketCondition === "DEAD") {
    cautionScore += 20;
    reasons.push("dead_market");
  }
  if ((conviction.confidence_score || 0) < 20) {
    cautionScore += 16;
    reasons.push("low_conviction_confidence");
  }
  if ((conviction.conviction_score || 0) < 35) {
    cautionScore += 14;
    reasons.push("weak_conviction");
  }
  if ((conviction.conviction_score || 0) >= 70 && (conviction.confidence_score || 0) >= 45) {
    cautionScore -= 12;
    reasons.push("strong_conviction");
  }

  cautionScore = clamp(cautionScore, 0, 100);

  let verdict = "active";
  let sizeMultiplier = 1;
  if (token.kelly?.should_skip || cautionScore >= 45) {
    verdict = "skip";
    sizeMultiplier = 0;
  } else if ((conviction.confidence_score || 0) < 20 || (conviction.conviction_score || 0) < 35) {
    verdict = "shadow";
    sizeMultiplier = 0;
  } else if (cautionScore >= 22 || (conviction.conviction_score || 0) < 65 || (conviction.confidence_score || 0) < 45) {
    verdict = "probe";
    sizeMultiplier = probeSizeFraction;
  }

  return {
    verdict,
    caution_score: cautionScore,
    reasons,
    size_multiplier: Number(sizeMultiplier.toFixed(4)),
    recommended_amount_sol: Number(((token.volatility_adjusted_size || 0) * sizeMultiplier).toFixed(4)),
    fast_track_eligible: verdict === "active" && cautionScore <= 18 && flagCount === 0 && token.momentum_entry_pass !== false,
    llm_can_buy: verdict === "probe" || verdict === "active",
  };
}
