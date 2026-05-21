/**
 * DexVisibilityRiskAnalyzer
 * Classifies Dex Paid / Ads / Boost visibility signals as POSITIVE, NEUTRAL,
 * DANGER, or HIGH_RISK. Pure analysis; never executes trades.
 *
 * Architecture: weighted hybrid scoring (base 50) + early-exit overrides.
 * Gemini research: weighted score beats pure rules for nuanced pump/organic combos.
 */

export const RiskStatus = Object.freeze({
  POSITIVE: "POSITIVE",
  NEUTRAL: "NEUTRAL",
  DANGER: "DANGER",
  HIGH_RISK: "HIGH_RISK",
});

const MarketCondition = Object.freeze({
  HOT: "HOT",
  NORMAL: "NORMAL",
  COLD: "COLD",
});

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMarketCondition(value) {
  const normalized = String(value || MarketCondition.NORMAL).toUpperCase();
  return MarketCondition[normalized] || MarketCondition.NORMAL;
}

function hasVisibilitySignal(tokenData) {
  return Boolean(tokenData.hasDexPaid || tokenData.hasAds || tokenData.hasBoost);
}

/**
 * @typedef {object} DexVisibilityInput
 * @property {number} tokenAgeMinutes
 * @property {number} [pricePumpPercent=0]
 * @property {number} [volumeUsd=0]
 * @property {number} [uniqueWallets=0]
 * @property {number} [organicCommunityScore=50] 0-100
 * @property {number} [narrativeScore=50] 0-100
 * @property {number} [top10HolderConcentration=0] 0-100
 * @property {number} [visibilitySignalAgeMinutes]
 * @property {boolean} [devWalletNotHolding=false]
 * @property {boolean} [hasDexPaid]
 * @property {boolean} [hasAds]
 * @property {boolean} [hasBoost]
 * @property {string} [marketCondition=NORMAL]
 * @property {string} [tokenAddress]
 *
 * @typedef {object} DexVisibilityOutput
 * @property {string} riskStatus
 * @property {number} visibilityRiskScore
 * @property {string[]} reasons
 * @property {boolean} isDistributionTrap
 * @property {boolean} isBullishSignal
 */

/**
 * @param {DexVisibilityInput} tokenData
 * @returns {DexVisibilityOutput}
 */
export function analyzeDexVisibilityRisk(tokenData = {}) {
  const tokenAgeMinutes = normalizeNumber(tokenData.tokenAgeMinutes, NaN);

  if (typeof tokenAgeMinutes !== "number" || !Number.isFinite(tokenAgeMinutes)) {
    return {
      riskStatus: RiskStatus.NEUTRAL,
      visibilityRiskScore: 50,
      reasons: ["tokenAgeMinutes missing or invalid - defaulting to NEUTRAL"],
      isDistributionTrap: false,
      isBullishSignal: false,
    };
  }

  const pricePumpPercent = normalizeNumber(tokenData.pricePumpPercent);
  const volumeUsd = normalizeNumber(tokenData.volumeUsd);
  const uniqueWallets = normalizeNumber(tokenData.uniqueWallets);
  const organicCommunityScore = clamp(normalizeNumber(tokenData.organicCommunityScore, 50), 0, 100);
  const narrativeScore = clamp(normalizeNumber(tokenData.narrativeScore, 50), 0, 100);
  const top10HolderConcentration = clamp(normalizeNumber(tokenData.top10HolderConcentration), 0, 100);
  const visibilitySignalAgeMinutes = tokenData.visibilitySignalAgeMinutes === undefined
    ? null
    : normalizeNumber(tokenData.visibilitySignalAgeMinutes, null);
  const devWalletNotHolding = Boolean(tokenData.devWalletNotHolding);
  const marketCondition = normalizeMarketCondition(tokenData.marketCondition);
  const visibilitySignalPresent = hasVisibilitySignal(tokenData);
  const lateVisibility = tokenAgeMinutes > 45
    && (visibilitySignalAgeMinutes === null || visibilitySignalAgeMinutes <= 15);
  const reasons = [];

  const dangerFlags = [
    pricePumpPercent >= 100,
    lateVisibility,
    top10HolderConcentration >= 30,
    devWalletNotHolding,
    organicCommunityScore < 30,
  ].filter(Boolean).length;

  if (dangerFlags === 5) {
    reasons.push("All core danger flags present: pump, late visibility, holder concentration, dev exit, weak organic score");
    return result(RiskStatus.HIGH_RISK, 95, reasons);
  }

  if (devWalletNotHolding && pricePumpPercent >= 50) {
    reasons.push(`Dev wallet exited after ${pricePumpPercent}% pump - distribution confirmed`);
    return result(RiskStatus.HIGH_RISK, 90, reasons);
  }

  if (tokenAgeMinutes > 60 && pricePumpPercent >= 100) {
    reasons.push(`Old token (${tokenAgeMinutes}m) with ${pricePumpPercent}% pump - exit liquidity trap`);
    return result(RiskStatus.HIGH_RISK, 88, reasons);
  }

  if (top10HolderConcentration > 40 && pricePumpPercent >= 80) {
    reasons.push(`Top-10 concentration ${top10HolderConcentration}% with ${pricePumpPercent}% pump - forced DANGER`);
    return result(RiskStatus.DANGER, 68, reasons);
  }

  if (pricePumpPercent >= 100 && lateVisibility && dangerFlags >= 4) {
    reasons.push(`Late visibility after ${pricePumpPercent}% pump with ${dangerFlags} danger flags`);
    return result(RiskStatus.DANGER, 74, reasons);
  }

  let score = 50;

  if (pricePumpPercent >= 100) {
    score += 30;
    reasons.push(`Price pumped ${pricePumpPercent}% (>= 100%) - distribution risk (+30)`);
  } else if (pricePumpPercent >= 70) {
    score += 15;
    reasons.push(`Price pumped ${pricePumpPercent}% (>= 70%) - elevated risk (+15)`);
  }

  if (devWalletNotHolding) {
    score += 25;
    reasons.push("Dev wallet no longer holding - exit risk (+25)");
  }

  if (top10HolderConcentration > 50) {
    score += 35;
    reasons.push(`Top-10 concentration ${top10HolderConcentration}% - extreme concentration (+35)`);
  } else if (top10HolderConcentration > 30) {
    score += 20;
    reasons.push(`Top-10 concentration ${top10HolderConcentration}% - high concentration (+20)`);
  }

  if (lateVisibility) {
    score += 25;
    reasons.push(`Late visibility signal at token age ${tokenAgeMinutes}m - likely distribution (+25)`);
  }

  if (tokenAgeMinutes > 60) {
    score += 20;
    reasons.push(`Token age ${tokenAgeMinutes}m (> 60m) - late visibility risk (+20)`);
  } else if (tokenAgeMinutes > 30 && volumeUsd >= 100000) {
    score += 15;
    reasons.push(`Visibility appeared at ${tokenAgeMinutes}m with $${volumeUsd} volume - late + high vol (+15)`);
  }

  if (organicCommunityScore < 30) {
    score += 20;
    reasons.push(`Very low organic community score ${organicCommunityScore} (+20)`);
  } else if (organicCommunityScore < 40) {
    score += 15;
    reasons.push(`Low organic community score ${organicCommunityScore} (+15)`);
  }

  if (uniqueWallets > 0 && volumeUsd / uniqueWallets > 5000) {
    score += 20;
    reasons.push(`Wash trading signal: $${(volumeUsd / uniqueWallets).toFixed(0)} avg per wallet (+20)`);
  }

  if (tokenAgeMinutes <= 15) {
    score -= 20;
    reasons.push(`Very early launch ${tokenAgeMinutes}m (< 15m) - fresh token bullish (-20)`);
  } else if (tokenAgeMinutes <= 30) {
    score -= 10;
    reasons.push(`Early launch ${tokenAgeMinutes}m (< 30m) - bullish timing (-10)`);
  }

  if (organicCommunityScore > 80) {
    score -= 15;
    reasons.push(`High organic community score ${organicCommunityScore} (-15)`);
  } else if (organicCommunityScore > 70) {
    score -= 8;
    reasons.push(`Good organic community score ${organicCommunityScore} (-8)`);
  }

  if (narrativeScore > 80) {
    score -= 15;
    reasons.push(`Strong narrative score ${narrativeScore} (-15)`);
  } else if (narrativeScore > 70) {
    score -= 8;
    reasons.push(`Good narrative score ${narrativeScore} (-8)`);
  }

  if (volumeUsd < 20000) {
    score -= 10;
    reasons.push(`Low volume $${volumeUsd} (< $20k) - pre-hype entry (-10)`);
  } else if (volumeUsd < 50000) {
    score -= 5;
    reasons.push(`Moderate volume $${volumeUsd} (< $50k) - still early (-5)`);
  }

  if (visibilitySignalPresent) {
    reasons.push("DEX visibility signal present");
  }

  if (marketCondition === MarketCondition.COLD && score >= 65) {
    score += 8;
    reasons.push("Cold market - lower tolerance for distribution signals (+8)");
  } else if (marketCondition === MarketCondition.HOT && score >= 55) {
    score -= 5;
    reasons.push("Hot market - slightly more tolerant of visibility risk (-5)");
  }

  score = clamp(score, 0, 100);

  if (reasons.length === 0) {
    reasons.push(`No strong signals detected - neutral baseline (score ${score})`);
  }

  let riskStatus;
  if (score < 30) riskStatus = RiskStatus.POSITIVE;
  else if (score < 55) riskStatus = RiskStatus.NEUTRAL;
  else if (score < 75) riskStatus = RiskStatus.DANGER;
  else riskStatus = RiskStatus.HIGH_RISK;

  return result(riskStatus, score, reasons);
}

function result(riskStatus, visibilityRiskScore, reasons) {
  return {
    riskStatus,
    visibilityRiskScore,
    reasons,
    isDistributionTrap: riskStatus === RiskStatus.DANGER || riskStatus === RiskStatus.HIGH_RISK,
    isBullishSignal: riskStatus === RiskStatus.POSITIVE,
  };
}
