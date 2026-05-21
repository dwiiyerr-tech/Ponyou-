/**
 * WalletPingAgent
 * Monitors tracked wallets and generates structured alerts.
 * Pure analysis layer — never executes trades, never emits buy/sell signals.
 */

export const WalletEventType = Object.freeze({
  BUY: "BUY",
  SELL: "SELL",
  CREATE_POOL: "CREATE_POOL",
  LP_ADD: "LP_ADD",
  BURN: "BURN",
  TRANSFER: "TRANSFER",
});

export const WalletQualityLevel = Object.freeze({
  ELITE: "ELITE",
  GOOD: "GOOD",
  AVERAGE: "AVERAGE",
  POOR: "POOR",
});

export const PingSeverity = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

export const WalletPingAction = Object.freeze({
  LOG: "LOG",
  NOTIFY: "NOTIFY",
  ROUTE_TO_ANALYZER: "ROUTE_TO_ANALYZER",
  FLAG_WALLET: "FLAG_WALLET",
});

/**
 * @typedef {object} WalletStats
 * @property {number} [winRate30d] Win rate over last 30 days (0–1).
 * @property {number} [profitFactor] Total gains / total losses.
 * @property {number} [memecoinWinRate] Win rate on tokens < 24h old (0–1).
 * @property {number} [earlyEntryPrecision] Normalized score for entry timing vs pool init (0–1).
 * @property {number} [positionSizeStability] Consistency of position sizing (0–1).
 * @property {number} [holdingDiscipline] Exit quality vs 24h peak (0–1).
 * @property {number} [walletAgeDays] Age of wallet in days.
 * @property {string|null} [fundedBy] Funding source identifier or "MIXER".
 * @property {string|null} [clusterId] Cluster group ID for relationship detection.
 * @property {boolean} [isKnownRugger] Wallet linked to prior rug-pull signatures.
 */

/**
 * @typedef {object} RelatedWalletCandidate
 * @property {string} address
 * @property {string} relationship Type of link (e.g., "same_funder", "same_cluster").
 * @property {number} fundingAmountSol SOL amount used to fund this wallet.
 */

/**
 * @typedef {object} RiskFlag
 * @property {string} type
 * @property {string} severity
 * @property {string} detail
 */

/**
 * @typedef {object} WalletPingInput
 * @property {string} [walletAddress]
 * @property {string} [event] WalletEventType value.
 * @property {string} [tokenMint]
 * @property {number} [tokenAgeMinutes]
 * @property {number} [pricePumpPercent] Price increase from pool open (%).
 * @property {number} [positionSizeSol] SOL size of current event.
 * @property {number} [avgPositionSizeSol] Wallet's 30-day average position size in SOL.
 * @property {number} [buyerRankInPool] Rank of this wallet among pool buyers (1 = first).
 * @property {number} [totalBuyersInPool] Total unique buyers in pool so far.
 * @property {RelatedWalletCandidate[]} [relatedWallets] Pre-computed related wallet candidates.
 * @property {Array<{qualityLevel: string, clusterId: string|null}>} [allCurrentBuyers] All current buyers with quality metadata.
 * @property {WalletStats} [stats]
 * @property {string|null} [creatorWallet] Token creator wallet address.
 * @property {string[]} [blacklistedTokens] Token mints on the blacklist.
 * @property {number} [recentWalletEvents] Count of buy/sell events by this wallet in last 5 minutes.
 * @property {number} [freshWalletBuyerPercent] Percent of current buyers with wallet age < 1 hour (0–100).
 * @property {number} [smartWalletSellCount] Count of ELITE/GOOD wallets selling the same token right now.
 * @property {number} [volumeToLiquidityRatio] Current volume/liquidity ratio.
 * @property {number} [prevVolToLiqRatio] Previous volume/liquidity ratio (for trend detection).
 */

/**
 * @typedef {object} WalletPingOutput
 * @property {boolean} isDirectBuySignal Always false.
 * @property {number} qualityScore 0–100.
 * @property {string} qualityLevel WalletQualityLevel value.
 * @property {string} severity PingSeverity value.
 * @property {string[]} actions WalletPingAction values.
 * @property {string[]} reasons Human-readable explanation of triggered rules.
 * @property {RelatedWalletCandidate[]} relatedWallets Filtered related wallets.
 * @property {RiskFlag[]} riskFlags Structured risk signals.
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

const SEVERITY_ORDER = [
  PingSeverity.LOW,
  PingSeverity.MEDIUM,
  PingSeverity.HIGH,
  PingSeverity.CRITICAL,
];

function severityIndex(s) {
  const idx = SEVERITY_ORDER.indexOf(s);
  return idx === -1 ? 0 : idx;
}

function raiseSeverity(current, targetOrSteps) {
  if (current === PingSeverity.CRITICAL) return PingSeverity.CRITICAL;
  if (typeof targetOrSteps === "string") {
    const tIdx = severityIndex(targetOrSteps);
    const cIdx = severityIndex(current);
    return SEVERITY_ORDER[Math.max(tIdx, cIdx)];
  }
  const steps = targetOrSteps ?? 1;
  const cIdx = severityIndex(current);
  return SEVERITY_ORDER[Math.min(cIdx + steps, SEVERITY_ORDER.length - 1)];
}

function lowerSeverity(current, steps = 1) {
  if (current === PingSeverity.CRITICAL) return PingSeverity.CRITICAL;
  const cIdx = severityIndex(current);
  return SEVERITY_ORDER[Math.max(cIdx - steps, 0)];
}

function qualityLevelFor(score) {
  if (score >= 80) return WalletQualityLevel.ELITE;
  if (score >= 60) return WalletQualityLevel.GOOD;
  if (score >= 40) return WalletQualityLevel.AVERAGE;
  return WalletQualityLevel.POOR;
}

/**
 * WalletQualityScorer — 7-factor weighted scoring.
 * @param {WalletStats} stats
 * @returns {{ qualityScore: number, qualityLevel: string }}
 */
export function scoreWalletQuality(stats = {}) {
  const winRate = number(stats.winRate30d, 0);
  const profitFactor = number(stats.profitFactor, 0);
  const memecoinWinRate = number(stats.memecoinWinRate, 0);
  const earlyEntry = clamp(number(stats.earlyEntryPrecision, 0), 0, 1);
  const posStability = clamp(number(stats.positionSizeStability, 0), 0, 1);
  const holdDisc = clamp(number(stats.holdingDiscipline, 0), 0, 1);
  const ageDays = number(stats.walletAgeDays, 0);
  const isKnownRugger = Boolean(stats.isKnownRugger);
  const fundedBy = stats.fundedBy ?? null;

  let score = 0;

  // Factor 1: winRate30d (max 20)
  if (winRate >= 0.65) score += 20;
  else if (winRate >= 0.55) score += 14;
  else if (winRate >= 0.45) score += 8;

  // Factor 2: profitFactor (max 20)
  if (profitFactor >= 3) score += 20;
  else if (profitFactor >= 2) score += 14;
  else if (profitFactor >= 1.5) score += 8;

  // Factor 3: memecoinWinRate (max 15)
  if (memecoinWinRate >= 0.6) score += 15;
  else if (memecoinWinRate >= 0.5) score += 10;
  else if (memecoinWinRate >= 0.4) score += 5;

  // Factor 4: earlyEntryPrecision (max 15)
  score += earlyEntry * 15;

  // Factor 5: positionSizeStability (max 10)
  score += posStability * 10;

  // Factor 6: holdingDiscipline (max 10)
  score += holdDisc * 10;

  // Factor 7: walletReputation (max 10)
  if (ageDays >= 180 && !isKnownRugger && fundedBy !== "MIXER") {
    score += 10;
  } else if (ageDays >= 30 && !isKnownRugger) {
    score += 5;
  }

  const qualityScore = clamp(Math.round(score), 0, 100);
  return { qualityScore, qualityLevel: qualityLevelFor(qualityScore) };
}

/**
 * WalletRelationshipExplorer — filter related wallets by funding threshold.
 * @param {WalletPingInput} input
 * @returns {RelatedWalletCandidate[]}
 */
export function detectRelatedWallets(input = {}) {
  return list(input.relatedWallets).filter(
    candidate => number(candidate?.fundingAmountSol, 0) >= 0.1,
  );
}

/**
 * Main entry point — processes a wallet ping event and returns structured alert output.
 * @param {WalletPingInput} input
 * @returns {WalletPingOutput}
 */
export function processWalletPing(input = {}) {
  const stats = input.stats ?? {};
  const { qualityScore, qualityLevel } = scoreWalletQuality(stats);

  const event = String(input.event ?? "");
  const tokenMint = String(input.tokenMint ?? "");
  const blacklistedTokens = list(input.blacklistedTokens);
  const recentWalletEvents = number(input.recentWalletEvents, 0);
  const pricePumpPercent = number(input.pricePumpPercent, 0);
  const positionSizeSol = number(input.positionSizeSol, 0);
  const avgPositionSizeSol = number(input.avgPositionSizeSol, 0);
  const buyerRankInPool = number(input.buyerRankInPool, 999);
  const totalBuyersInPool = number(input.totalBuyersInPool, 0);
  const creatorWallet = input.creatorWallet ?? null;
  const freshWalletBuyerPercent = number(input.freshWalletBuyerPercent, 0);
  const smartWalletSellCount = number(input.smartWalletSellCount, 0);
  const volumeToLiquidityRatio = number(input.volumeToLiquidityRatio, 0);
  const prevVolToLiqRatio = number(input.prevVolToLiqRatio, 0);

  const baseOutput = {
    isDirectBuySignal: false,
    qualityScore,
    qualityLevel,
  };

  // Rule 0 — Wash trade filter (PingRiskGuard)
  if (recentWalletEvents >= 5) {
    return {
      ...baseOutput,
      severity: PingSeverity.LOW,
      actions: [WalletPingAction.LOG],
      reasons: ["Wash trade pattern detected — signal suppressed"],
      relatedWallets: [],
      riskFlags: [{ type: "WASH_TRADE", severity: PingSeverity.HIGH, detail: "5+ buy/sell events in 5min" }],
    };
  }

  // Rule 1 — Blacklisted token (PingRiskGuard)
  if (tokenMint && blacklistedTokens.includes(tokenMint)) {
    return {
      ...baseOutput,
      severity: PingSeverity.LOW,
      actions: [WalletPingAction.LOG],
      reasons: ["Token on blacklist — signal suppressed"],
      relatedWallets: [],
      riskFlags: [{ type: "BLACKLISTED_TOKEN", severity: PingSeverity.HIGH, detail: `Token ${tokenMint} is blacklisted` }],
    };
  }

  // Main rules
  const relatedWallets = detectRelatedWallets(input);
  const actions = new Set();
  const reasons = [];
  const riskFlags = [];
  let severity = PingSeverity.LOW;

  const isGoodOrElite = qualityLevel === WalletQualityLevel.ELITE || qualityLevel === WalletQualityLevel.GOOD;

  // Rule 2 — Elite lead entry
  if (qualityLevel === WalletQualityLevel.ELITE && buyerRankInPool <= 10 && totalBuyersInPool >= 20) {
    severity = raiseSeverity(severity, PingSeverity.HIGH);
    actions.add(WalletPingAction.NOTIFY);
    actions.add(WalletPingAction.ROUTE_TO_ANALYZER);
    reasons.push("Elite wallet entered top-10 of pool");
  }

  // Rule 3 — High-conviction size
  if (isGoodOrElite && avgPositionSizeSol > 0 && positionSizeSol >= avgPositionSizeSol * 2) {
    severity = raiseSeverity(severity, PingSeverity.HIGH);
    actions.add(WalletPingAction.NOTIFY);
    actions.add(WalletPingAction.ROUTE_TO_ANALYZER);
    const multiplier = (positionSizeSol / avgPositionSizeSol).toFixed(1);
    reasons.push(`High-conviction oversized entry (${multiplier}x avg)`);
  }

  // Rule 4 — Insider lineage
  if (creatorWallet && stats.fundedBy === creatorWallet) {
    severity = PingSeverity.CRITICAL;
    actions.add(WalletPingAction.FLAG_WALLET);
    actions.add(WalletPingAction.NOTIFY);
    reasons.push("Wallet funded by token creator");
    riskFlags.push({ type: "INSIDER_LINEAGE", severity: PingSeverity.CRITICAL, detail: `Funded by creator ${creatorWallet}` });
  }

  // Rule 5 — Cluster expansion
  if (relatedWallets.length >= 3) {
    actions.add(WalletPingAction.ROUTE_TO_ANALYZER);
    reasons.push(`${relatedWallets.length} related wallets in same cluster`);
  }

  // Rule 6 — Smart money exodus
  if (event === WalletEventType.SELL && qualityLevel === WalletQualityLevel.ELITE && avgPositionSizeSol > 0 && positionSizeSol >= avgPositionSizeSol * 0.75) {
    severity = raiseSeverity(severity, PingSeverity.HIGH);
    actions.add(WalletPingAction.NOTIFY);
    reasons.push("Elite wallet exiting large position");
  }

  // Rule 7 — Directional conflict
  if (smartWalletSellCount >= 1 && qualityLevel === WalletQualityLevel.ELITE && event === WalletEventType.BUY) {
    severity = PingSeverity.CRITICAL;
    actions.add(WalletPingAction.FLAG_WALLET);
    actions.add(WalletPingAction.NOTIFY);
    reasons.push("Directional conflict: elite buying while smart wallets sell");
    riskFlags.push({ type: "DIRECTIONAL_CONFLICT", severity: PingSeverity.CRITICAL, detail: `${smartWalletSellCount} smart wallet(s) selling while this wallet buys` });
  }

  // Rule 8 — Liquidity warning
  if (isGoodOrElite && event === WalletEventType.SELL && prevVolToLiqRatio > 0 && volumeToLiquidityRatio < prevVolToLiqRatio * 0.7) {
    actions.add(WalletPingAction.NOTIFY);
    reasons.push("Smart wallet selling into declining liquidity");
  }

  // Rule 10 — Global conviction (before anti-fomo guard so guard can downgrade)
  if (list(input.allCurrentBuyers).length > 0) {
    const walletClusterId = stats.clusterId ?? null;
    const unrelatedQualityBuyers = list(input.allCurrentBuyers).filter(buyer => {
      const bLevel = buyer?.qualityLevel;
      const bCluster = buyer?.clusterId ?? null;
      const isQuality = bLevel === WalletQualityLevel.ELITE || bLevel === WalletQualityLevel.GOOD;
      const isUnrelated = bCluster !== walletClusterId || bCluster === null;
      return isQuality && isUnrelated;
    });
    if (unrelatedQualityBuyers.length >= 3) {
      severity = raiseSeverity(severity, PingSeverity.HIGH);
      actions.add(WalletPingAction.ROUTE_TO_ANALYZER);
      reasons.push(`${unrelatedQualityBuyers.length} unrelated quality wallets entered`);
    }
  }

  // Rule 11 — Rugger activity
  if ((event === WalletEventType.CREATE_POOL || event === WalletEventType.LP_ADD) && stats.isKnownRugger) {
    severity = PingSeverity.CRITICAL;
    actions.add(WalletPingAction.FLAG_WALLET);
    reasons.push("Known rugger creating/adding LP");
    riskFlags.push({ type: "RUGGER_ACTIVITY", severity: PingSeverity.CRITICAL, detail: "Known rugger creating or adding liquidity" });
  }

  // Rule 9 — Anti-fomo guard (runs after severity-raising rules)
  if (pricePumpPercent >= 200) {
    severity = lowerSeverity(severity);
    reasons.push("Severity downgraded: entering after 200%+ pump");
  }

  // Rule 12 — Sybil saturation
  if (freshWalletBuyerPercent >= 80) {
    severity = lowerSeverity(severity);
    reasons.push("Sybil saturation: 80%+ fresh wallets");
  }

  // Finalize actions
  if (actions.size === 0) {
    actions.add(WalletPingAction.LOG);
  }

  return {
    isDirectBuySignal: false,
    qualityScore,
    qualityLevel,
    severity,
    actions: Array.from(actions),
    reasons: reasons.length ? reasons : ["No alert rules triggered"],
    relatedWallets,
    riskFlags,
  };
}
