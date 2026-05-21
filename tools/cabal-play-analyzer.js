/**
 * CabalPlayAnalyzer
 * Detects coordinated-wallet risk patterns from on-chain wallet data.
 * Pure analysis layer; never executes trades and never emits BUY/SELL actions.
 */

export const CabalType = Object.freeze({
  NONE: "NONE",
  GROUP_CABAL: "GROUP_CABAL",
  SOLO_CABAL: "SOLO_CABAL",
  CONFLICT_CABAL: "CONFLICT_CABAL",
  DISTRIBUTION_RISK: "DISTRIBUTION_RISK",
  FOMO_RISK: "FOMO_RISK",
});

export const CabalRiskLevel = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

export const CabalAgentAction = Object.freeze({
  WATCH_ONLY: "WATCH_ONLY",
  REQUIRE_CONFIRMATION: "REQUIRE_CONFIRMATION",
  WATCH_DOMINANT_WALLET: "WATCH_DOMINANT_WALLET",
  WAIT_FOR_RESOLUTION: "WAIT_FOR_RESOLUTION",
  WAIT_FOR_COOLDOWN: "WAIT_FOR_COOLDOWN",
  BLOCK_ENTRY: "BLOCK_ENTRY",
});

const DEFAULTS = Object.freeze({
  maxCoordinatedWindowMinutes: 10,
  groupScoreThreshold: 50,
  soloScoreThreshold: 45,
  conflictScoreThreshold: 55,
  distributionScoreThreshold: 60,
  fomoScoreThreshold: 55,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstFinite(values, fallback = 0) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function maxFinite(values, fallback = 0) {
  let found = fallback;
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) found = Math.max(found, n);
  }
  return found;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function pickWallets(input) {
  const wallets = list(input.wallets);
  return wallets.length ? wallets : list(input.holders);
}

function walletField(wallet, keys) {
  for (const key of keys) {
    if (wallet?.[key] != null && wallet[key] !== "") return wallet[key];
  }
  return null;
}

function maxGroupCount(wallets, keys) {
  const groups = new Map();
  for (const wallet of wallets) {
    const value = walletField(wallet, keys);
    if (!value) continue;
    const group = String(value);
    groups.set(group, (groups.get(group) || 0) + 1);
  }

  return Math.max(0, ...groups.values());
}

function maxWalletPct(wallets) {
  return Math.max(
    0,
    ...wallets.map(wallet => number(
      wallet?.supplyPercent
      ?? wallet?.supply_percent
      ?? wallet?.pct
      ?? wallet?.percentage
      ?? wallet?.percent,
    )),
  );
}

function maxRolePct(wallets, roles) {
  const wanted = new Set(roles.map(role => role.toLowerCase()));
  return Math.max(
    0,
    ...wallets
      .filter(wallet => wanted.has(String(wallet?.role || "").toLowerCase()))
      .map(wallet => number(
        wallet?.supplyPercent
        ?? wallet?.supply_percent
        ?? wallet?.pct
        ?? wallet?.percentage
        ?? wallet?.percent,
      )),
  );
}

function maxWalletNetFlow(wallets) {
  return Math.max(
    0,
    ...wallets.map(wallet => number(
      wallet?.netFlowSol
      ?? wallet?.net_flow_sol
      ?? wallet?.netFlow
      ?? wallet?.net_flow,
    )),
  );
}

function countWalletAction(wallets, fragments) {
  return wallets.filter(wallet => {
    const action = String(wallet?.lastAction ?? wallet?.action ?? wallet?.side ?? "").toUpperCase();
    return fragments.some(fragment => action.includes(fragment));
  }).length;
}

function deriveMetrics(input) {
  const rugSignals = input.rugSignals || input.rug_signals || {};
  const wallets = pickWallets(input);
  const maxHolderPct = maxFinite([
    input.maxHolderPct,
    input.max_holder_pct,
    rugSignals.max_holder_pct,
    maxWalletPct(wallets),
  ]);
  const devPct = maxFinite([
    input.devWalletSupplyPercent,
    input.dev_wallet_supply_percent,
    input.devPct,
    input.dev_pct,
    maxRolePct(wallets, ["dev", "developer"]),
  ]);
  const creatorPct = maxFinite([
    input.creatorSupplyPercent,
    input.creator_pct,
    rugSignals.creator_pct,
    maxRolePct(wallets, ["creator", "owner"]),
  ]);
  const coordinatedBuyWallets = maxFinite([
    input.coordinatedBuyWallets,
    input.coordinated_buy_wallets,
    countWalletAction(wallets, ["BUY", "ACCUMULAT"]),
  ]);
  const coordinatedSellWallets = maxFinite([
    input.coordinatedSellWallets,
    input.coordinated_sell_wallets,
    countWalletAction(wallets, ["SELL", "DUMP", "EXIT"]),
  ]);

  return {
    wallets,
    hasInput: Object.keys(input || {}).length > 0,
    tokenAgeMinutes: firstFinite([input.tokenAgeMinutes, input.token_age_minutes], 0),
    pricePumpPercent: firstFinite([input.pricePumpPercent, input.price_pump_percent], 0),
    volumeUsd: firstFinite([input.volumeUsd, input.volume_usd], 0),
    uniqueWallets: firstFinite([input.uniqueWallets, input.unique_wallets], 0),
    top10HolderConcentration: maxFinite([
      input.top10HolderConcentration,
      input.top10Pct,
      input.top10_pct,
      rugSignals.top10_concentration_pct,
    ]),
    maxHolderPct,
    devPct,
    creatorPct,
    sameFunderWallets: maxFinite([
      input.sameFunderWallets,
      input.sameFunderHolders,
      input.same_funder_holders,
      rugSignals.same_funder_holders,
      maxGroupCount(wallets, ["fundedBy", "funded_by", "commonFunder", "common_funder"]),
    ]),
    relatedWalletCount: maxFinite([
      input.relatedWalletCount,
      input.related_wallet_count,
      maxGroupCount(wallets, ["relationGroupId", "relation_group_id", "clusterId", "cluster_id"]),
    ]),
    coordinatedBuyWallets,
    coordinatedSellWallets,
    coordinatedBuyWindowMinutes: firstFinite([
      input.coordinatedBuyWindowMinutes,
      input.coordinated_buy_window_minutes,
    ], 999),
    coordinatedSellWindowMinutes: firstFinite([
      input.coordinatedSellWindowMinutes,
      input.coordinated_sell_window_minutes,
    ], 999),
    bundledLaunchScore: maxFinite([
      input.bundledLaunchScore,
      input.bundled_score,
      rugSignals.bundled_score,
    ]),
    bundleBuyersPct: maxFinite([
      input.bundleBuyersPct,
      input.bundle_buyers_pct,
      rugSignals.bundle_buyers_pct,
    ]),
    freshFundedWallets: maxFinite([
      input.freshFundedWallets,
      input.fresh_funded_holders,
      rugSignals.fresh_funded_holders,
    ]),
    dustWallets: maxFinite([
      input.dustWallets,
      input.dust_holders,
      rugSignals.dust_holders,
    ]),
    devWalletNotHolding: Boolean(input.devWalletNotHolding ?? input.dev_wallet_not_holding),
    devNetFlowSol: firstFinite([input.devNetFlowSol, input.dev_net_flow_sol], 0),
    creatorNetFlowSol: firstFinite([input.creatorNetFlowSol, input.creator_net_flow_sol], 0),
    dominantWalletNetFlowSol: maxFinite([
      input.dominantWalletNetFlowSol,
      input.dominant_wallet_net_flow_sol,
      maxWalletNetFlow(wallets),
    ]),
    smartWalletBuys: firstFinite([input.smartWalletBuys, input.smart_wallet_buys], 0),
    smartWalletSells: firstFinite([input.smartWalletSells, input.smart_wallet_sells], 0),
    retailBuyCount: firstFinite([input.retailBuyCount, input.retail_buy_count], 0),
    retailSellCount: firstFinite([input.retailSellCount, input.retail_sell_count], 0),
    buyPressurePercent: firstFinite([input.buyPressurePercent, input.buy_pressure_percent], 50),
    sellPressurePercent: firstFinite([input.sellPressurePercent, input.sell_pressure_percent], 50),
    socialHypeScore: clamp(firstFinite([input.socialHypeScore, input.social_hype_score], 50), 0, 100),
    organicCommunityScore: clamp(firstFinite([input.organicCommunityScore, input.organic_community_score], 50), 0, 100),
    knownCabalWallets: firstFinite([input.knownCabalWallets, input.known_cabal_wallets], 0),
  };
}

function pushEvidence(evidence, condition, score, reason) {
  if (!condition) return 0;
  evidence.push(reason);
  return score;
}

function detectGroupCabal(metrics, cfg) {
  const evidence = [];
  let score = 0;
  const coordinatedBuyCluster =
    (metrics.coordinatedBuyWallets >= 4 && metrics.coordinatedBuyWindowMinutes <= cfg.maxCoordinatedWindowMinutes)
    || metrics.coordinatedBuyWallets >= 6;

  score += pushEvidence(evidence, metrics.sameFunderWallets >= 3, 30, `${metrics.sameFunderWallets} wallets share the same funder`);
  score += pushEvidence(evidence, metrics.relatedWalletCount >= 4, 25, `${metrics.relatedWalletCount} wallets sit in the same relation cluster`);
  score += pushEvidence(evidence, coordinatedBuyCluster, 25, `${metrics.coordinatedBuyWallets} wallets accumulated in a tight window`);
  score += pushEvidence(evidence, metrics.bundleBuyersPct >= 25 || metrics.bundledLaunchScore >= 5, 20, "Bundle/launch cluster is large enough to suggest coordinated entry");
  score += pushEvidence(evidence, metrics.freshFundedWallets >= 5, 10, `${metrics.freshFundedWallets} wallets were freshly funded`);
  score += pushEvidence(evidence, metrics.top10HolderConcentration >= 45, 8, `Top-10 holder concentration is ${metrics.top10HolderConcentration}%`);

  return {
    type: CabalType.GROUP_CABAL,
    action: CabalAgentAction.REQUIRE_CONFIRMATION,
    priority: 75,
    score: clamp(score, 0, 100),
    evidence,
    detected: score >= cfg.groupScoreThreshold && evidence.length >= 2,
  };
}

function detectSoloCabal(metrics, cfg) {
  const evidence = [];
  let score = 0;
  const insiderPct = Math.max(metrics.devPct, metrics.creatorPct);

  score += pushEvidence(evidence, metrics.maxHolderPct >= 15, 45, `Single holder controls ${metrics.maxHolderPct}%`);
  score += pushEvidence(evidence, metrics.maxHolderPct >= 10 && metrics.maxHolderPct < 15, 30, `Single holder controls ${metrics.maxHolderPct}%`);
  score += pushEvidence(evidence, insiderPct >= 8, 25, `Developer/creator wallet controls ${insiderPct}%`);
  score += pushEvidence(evidence, metrics.knownCabalWallets === 1, 20, "Exactly one known cabal wallet is active");
  score += pushEvidence(evidence, metrics.dominantWalletNetFlowSol >= 3, 10, `Dominant wallet net inflow is ${metrics.dominantWalletNetFlowSol} SOL`);
  score += pushEvidence(evidence, metrics.top10HolderConcentration >= 50 && metrics.maxHolderPct >= 8, 15, `Top-10 concentration ${metrics.top10HolderConcentration}% amplifies the dominant holder risk`);

  return {
    type: CabalType.SOLO_CABAL,
    action: score >= 80 ? CabalAgentAction.BLOCK_ENTRY : CabalAgentAction.WATCH_DOMINANT_WALLET,
    priority: 70,
    score: clamp(score, 0, 100),
    evidence,
    detected: score >= cfg.soloScoreThreshold && (metrics.maxHolderPct >= 10 || insiderPct >= 8 || metrics.knownCabalWallets === 1),
  };
}

function detectConflictCabal(metrics, cfg) {
  const evidence = [];
  let score = 0;
  const buyCluster = metrics.coordinatedBuyWallets >= 3;
  const sellCluster = metrics.coordinatedSellWallets >= 3;
  const balancedPressure = metrics.buyPressurePercent >= 45
    && metrics.buyPressurePercent <= 65
    && metrics.sellPressurePercent >= 40
    && metrics.sellPressurePercent <= 65;

  score += pushEvidence(evidence, buyCluster && sellCluster, 45, `${metrics.coordinatedBuyWallets} coordinated accumulators conflict with ${metrics.coordinatedSellWallets} coordinated exits`);
  score += pushEvidence(evidence, metrics.smartWalletBuys >= 2 && metrics.smartWalletSells >= 2, 20, "Tracked smart wallets are split on direction");
  score += pushEvidence(evidence, balancedPressure, 15, `Buy/sell pressure is balanced at ${metrics.buyPressurePercent}%/${metrics.sellPressurePercent}%`);
  score += pushEvidence(evidence, metrics.pricePumpPercent >= 50, 10, `Conflict appears after ${metrics.pricePumpPercent}% pump`);
  score += pushEvidence(evidence, metrics.devNetFlowSol < 0 && metrics.coordinatedBuyWallets >= 3, 18, "Insider outflow conflicts with fresh coordinated accumulation");

  return {
    type: CabalType.CONFLICT_CABAL,
    action: CabalAgentAction.WAIT_FOR_RESOLUTION,
    priority: 90,
    score: clamp(score, 0, 100),
    evidence,
    detected: score >= cfg.conflictScoreThreshold && (buyCluster && sellCluster || metrics.smartWalletBuys >= 2 && metrics.smartWalletSells >= 2),
  };
}

function detectDistributionRisk(metrics, cfg) {
  const evidence = [];
  let score = 0;
  const insiderExit = metrics.devWalletNotHolding
    || metrics.devNetFlowSol <= -2
    || metrics.creatorNetFlowSol <= -2;
  const sellCluster =
    (metrics.coordinatedSellWallets >= 3 && metrics.coordinatedSellWindowMinutes <= 15)
    || metrics.coordinatedSellWallets >= 5;
  const postPump = metrics.pricePumpPercent >= 70 || metrics.tokenAgeMinutes >= 60;
  const highSellPressure = metrics.sellPressurePercent >= 60 || (
    metrics.retailSellCount > 0
    && metrics.retailBuyCount > 0
    && metrics.retailSellCount >= metrics.retailBuyCount * 1.4
  );

  score += pushEvidence(evidence, metrics.pricePumpPercent >= 100, 25, `Price already pumped ${metrics.pricePumpPercent}%`);
  score += pushEvidence(evidence, metrics.pricePumpPercent >= 70 && metrics.pricePumpPercent < 100, 15, `Price already pumped ${metrics.pricePumpPercent}%`);
  score += pushEvidence(evidence, insiderExit, 30, "Developer/creator wallet is exiting or no longer holding");
  score += pushEvidence(evidence, sellCluster, 25, `${metrics.coordinatedSellWallets} wallets exited in a coordinated window`);
  score += pushEvidence(evidence, metrics.top10HolderConcentration >= 40 && highSellPressure, 15, `Concentrated holders are selling into ${metrics.sellPressurePercent}% sell pressure`);
  score += pushEvidence(evidence, metrics.smartWalletSells >= 3, 10, `${metrics.smartWalletSells} tracked wallets are exiting`);

  return {
    type: CabalType.DISTRIBUTION_RISK,
    action: CabalAgentAction.BLOCK_ENTRY,
    priority: 100,
    score: clamp(score, 0, 100),
    evidence,
    detected: score >= cfg.distributionScoreThreshold
      && (insiderExit || sellCluster)
      && (postPump || highSellPressure || metrics.top10HolderConcentration >= 40),
  };
}

function detectFomoRisk(metrics, cfg) {
  const evidence = [];
  let score = 0;
  const retailRush = metrics.retailBuyCount >= 100
    || metrics.socialHypeScore >= 80
    || (metrics.uniqueWallets >= 200 && metrics.volumeUsd >= 100_000);
  const weakCabalEvidence = metrics.smartWalletBuys < 2
    && metrics.coordinatedBuyWallets < 3
    && metrics.sameFunderWallets < 3;
  const weakOrganicSignal = metrics.organicCommunityScore < 55;

  score += pushEvidence(evidence, metrics.pricePumpPercent >= 60, 20, `Price has already extended ${metrics.pricePumpPercent}%`);
  score += pushEvidence(evidence, metrics.socialHypeScore >= 80, 20, `Social hype score is ${metrics.socialHypeScore}`);
  score += pushEvidence(evidence, metrics.retailBuyCount >= 100, 20, `${metrics.retailBuyCount} retail entries detected`);
  score += pushEvidence(evidence, metrics.buyPressurePercent >= 70, 10, `Buy pressure is ${metrics.buyPressurePercent}%`);
  score += pushEvidence(evidence, weakCabalEvidence, 10, "Retail flow is not backed by visible smart-wallet or cabal accumulation");
  score += pushEvidence(evidence, weakOrganicSignal, 10, `Organic community score is only ${metrics.organicCommunityScore}`);
  score += pushEvidence(evidence, metrics.uniqueWallets >= 200 && metrics.volumeUsd >= 100_000, 8, "High wallet count and volume suggest crowd chase");

  return {
    type: CabalType.FOMO_RISK,
    action: CabalAgentAction.WAIT_FOR_COOLDOWN,
    priority: 65,
    score: clamp(score, 0, 100),
    evidence,
    detected: score >= cfg.fomoScoreThreshold
      && retailRush
      && metrics.pricePumpPercent >= 40
      && (weakCabalEvidence || weakOrganicSignal),
  };
}

function riskLevelFor(candidate) {
  if (candidate.type === CabalType.DISTRIBUTION_RISK && candidate.score >= 85) {
    return CabalRiskLevel.CRITICAL;
  }
  if (candidate.score >= 80) return CabalRiskLevel.HIGH;
  if (candidate.score >= 55) return CabalRiskLevel.MEDIUM;
  return CabalRiskLevel.LOW;
}

function confidenceFor(metrics, candidate) {
  if (candidate.type === CabalType.NONE) return metrics.hasInput ? 0.55 : 0.3;

  const dataPoints = [
    metrics.wallets.length > 0,
    metrics.sameFunderWallets > 0,
    metrics.relatedWalletCount > 0,
    metrics.maxHolderPct > 0 || metrics.top10HolderConcentration > 0,
    metrics.coordinatedBuyWallets > 0 || metrics.coordinatedSellWallets > 0,
    metrics.pricePumpPercent > 0,
    metrics.retailBuyCount > 0 || metrics.socialHypeScore !== 50,
    metrics.smartWalletBuys > 0 || metrics.smartWalletSells > 0,
  ].filter(Boolean).length;
  const evidenceStrength = clamp(candidate.evidence.length / 5, 0, 1);
  const scoreStrength = candidate.score / 100;
  const dataCompleteness = dataPoints / 8;
  const confidence = 0.22 + evidenceStrength * 0.35 + scoreStrength * 0.28 + dataCompleteness * 0.15;

  return Number(clamp(confidence, 0.15, 0.95).toFixed(2));
}

function buildPatternSignals(patterns) {
  return {
    groupCabal: patterns.group.detected,
    soloCabal: patterns.solo.detected,
    conflictCabal: patterns.conflict.detected,
    distributionRisk: patterns.distribution.detected,
    fomoRisk: patterns.fomo.detected,
    scores: {
      groupCabal: patterns.group.score,
      soloCabal: patterns.solo.score,
      conflictCabal: patterns.conflict.score,
      distributionRisk: patterns.distribution.score,
      fomoRisk: patterns.fomo.score,
    },
  };
}

/**
 * @typedef {object} CabalPlayInput
 * @property {Array<object>} [wallets] Wallet/holder observations.
 * @property {Array<object>} [holders] Alias for wallets.
 * @property {object} [rugSignals] Optional existing holder/rug telemetry.
 * @property {number} [sameFunderWallets]
 * @property {number} [relatedWalletCount]
 * @property {number} [coordinatedBuyWallets]
 * @property {number} [coordinatedSellWallets]
 * @property {number} [maxHolderPct]
 * @property {number} [top10HolderConcentration]
 * @property {number} [pricePumpPercent]
 * @property {number} [socialHypeScore]
 *
 * @typedef {object} CabalPlayOutput
 * @property {string} cabalType
 * @property {string} riskLevel
 * @property {string} action
 * @property {number} cabalScore
 * @property {number} confidence
 * @property {string[]} reasons
 * @property {boolean} isDirectBuySignal Always false.
 * @property {object} patternSignals
 */

/**
 * @param {CabalPlayInput} input
 * @param {Partial<typeof DEFAULTS>} overrides
 * @returns {CabalPlayOutput}
 */
export function analyzeCabalPlay(input = {}, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const metrics = deriveMetrics(input || {});
  const patterns = {
    group: detectGroupCabal(metrics, cfg),
    solo: detectSoloCabal(metrics, cfg),
    conflict: detectConflictCabal(metrics, cfg),
    distribution: detectDistributionRisk(metrics, cfg),
    fomo: detectFomoRisk(metrics, cfg),
  };
  const candidates = Object.values(patterns)
    .filter(candidate => candidate.detected)
    .sort((a, b) => b.priority - a.priority || b.score - a.score);

  const selected = candidates[0] || {
    type: CabalType.NONE,
    action: CabalAgentAction.WATCH_ONLY,
    priority: 0,
    score: 0,
    evidence: metrics.hasInput
      ? ["No coordinated cabal pattern crossed the routing threshold"]
      : ["No wallet/cabal signals supplied - watch only"],
    detected: false,
  };

  const secondaryPatterns = candidates
    .filter(candidate => candidate.type !== selected.type)
    .map(candidate => candidate.type);
  const reasons = [...selected.evidence];
  if (secondaryPatterns.length) {
    reasons.push(`Secondary patterns also present: ${secondaryPatterns.join(", ")}`);
  }

  return {
    cabalType: selected.type,
    riskLevel: riskLevelFor(selected),
    action: selected.action,
    cabalScore: selected.score,
    confidence: confidenceFor(metrics, selected),
    reasons,
    isDirectBuySignal: false,
    patternSignals: buildPatternSignals(patterns),
  };
}
