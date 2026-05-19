import { normalizeRegime } from "./market-regime.js";

const DEFAULT_POLICY = Object.freeze({
  entry: {
    hardBlockRugScore: 60,
    shadowConfidenceFloor: 20,
    probeConfidenceFloor: 35,
    probeCautionThreshold: 22,
    activeConfidenceFloor: 45,
    flagTolerance: 0,
  },
  sizing: {
    minFraction: 0,
    maxFraction: 1,
    probeSizeFraction: 0.35,
    hotBoost: 0.1,
    coldPenalty: 0.1,
  },
  exit: {
    hardStopLossPct: -15,
    hardCutLossPct: -25,
    immediateTakeProfitPct: null,
    trailingTriggerPct: 3,
    trailingDropPct: 1.5,
    profitSweepPct: 35,
  },
  rug: {
    seedHardBlock: true,
    learnedSoftByDefault: true,
    learnedConfidenceFloor: 0.8,
    learnedReviewRequired: true,
  },
});

function clonePolicy() {
  return {
    entry: { ...DEFAULT_POLICY.entry },
    sizing: { ...DEFAULT_POLICY.sizing },
    exit: { ...DEFAULT_POLICY.exit },
    rug: { ...DEFAULT_POLICY.rug },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeMarketCondition(value = "NORMAL") {
  return normalizeRegime(value, "NORMAL");
}

function adjustByMarket(policy, marketCondition) {
  const condition = normalizeMarketCondition(marketCondition);
  if (condition === "HOT") {
    policy.entry.probeCautionThreshold = 28;
    policy.entry.probeConfidenceFloor = 30;
    policy.entry.activeConfidenceFloor = 40;
    policy.sizing.probeSizeFraction = 0.45;
    policy.sizing.hotBoost = 0.15;
    policy.exit.hardStopLossPct = -18;
    policy.exit.hardCutLossPct = -28;
    policy.exit.trailingTriggerPct = 4;
    policy.exit.trailingDropPct = 2;
    policy.exit.profitSweepPct = 45;
  } else if (condition === "COLD") {
    policy.entry.probeCautionThreshold = 18;
    policy.entry.probeConfidenceFloor = 40;
    policy.entry.activeConfidenceFloor = 55;
    policy.sizing.probeSizeFraction = 0.25;
    policy.sizing.coldPenalty = 0.15;
    policy.exit.hardStopLossPct = -10;
    policy.exit.hardCutLossPct = -18;
    policy.exit.trailingTriggerPct = 2.5;
    policy.exit.trailingDropPct = 1.25;
    policy.exit.profitSweepPct = 30;
  } else if (condition === "DEAD") {
    policy.entry.probeCautionThreshold = 0;
    policy.entry.probeConfidenceFloor = 100;
    policy.entry.activeConfidenceFloor = 100;
    policy.sizing.probeSizeFraction = 0;
    policy.sizing.minFraction = 0;
    policy.exit.hardStopLossPct = -5;
    policy.exit.hardCutLossPct = -10;
    policy.exit.trailingTriggerPct = 0;
    policy.exit.trailingDropPct = 0;
    policy.exit.profitSweepPct = 0;
  }
  return policy;
}

export function buildRiskPolicy({ marketCondition = "NORMAL", conviction = {}, token = {}, config = {} } = {}) {
  const policy = clonePolicy();
  adjustByMarket(policy, marketCondition);

  const convictionScore = Number(conviction.conviction_score || 0);
  const convictionConfidence = Number(conviction.confidence_score || 0);
  const rugScore = Number(token.rug_score || 0);
  const flagCount = Array.isArray(token.flags) ? token.flags.length : 0;

  if (convictionScore >= 70 && convictionConfidence >= 45) {
    policy.entry.probeCautionThreshold = Math.max(16, policy.entry.probeCautionThreshold - 6);
    policy.sizing.probeSizeFraction = clamp(policy.sizing.probeSizeFraction + 0.05, 0.1, 0.6);
  }

  if (rugScore >= policy.entry.hardBlockRugScore) {
    policy.entry.flagTolerance = 0;
  } else if (rugScore >= 35) {
    policy.entry.flagTolerance = 0;
    policy.sizing.probeSizeFraction = Math.min(policy.sizing.probeSizeFraction, 0.25);
  }

  if (flagCount >= 2) {
    policy.entry.flagTolerance = 0;
    policy.sizing.probeSizeFraction = Math.min(policy.sizing.probeSizeFraction, 0.25);
  }

  const defaultStopLossPct = policy.exit.hardStopLossPct;
  let stopLossPct = defaultStopLossPct;
  if (Number.isFinite(config?.management?.stopLossPct)) {
    stopLossPct = config.management.stopLossPct;
    if (stopLossPct < -50 || stopLossPct > -1) {
      console.warn(`[risk-policy] stopLossPct ${stopLossPct} out of range [-50, -1], using default`);
      stopLossPct = defaultStopLossPct;
    }
  }
  const takeProfitPct = Number.isFinite(config?.management?.takeProfitPct)
    ? config.management.takeProfitPct
    : Number.isFinite(config?.management?.autoTakeProfitPct)
      ? config.management.autoTakeProfitPct
      : null;

  policy.exit.hardStopLossPct = stopLossPct;
  policy.exit.immediateTakeProfitPct = takeProfitPct;

  return policy;
}

export function evaluateExitPolicy({
  pnlPct = 0,
  peakPnlPct = 0,
  policy = buildRiskPolicy(),
} = {}) {
  const policyExit = policy?.exit || DEFAULT_POLICY.exit;
  const pnl = Number(pnlPct || 0);
  const peak = Number(peakPnlPct || 0);

  const hardCutLoss = pnl <= policyExit.hardCutLossPct;
  const hardStopLoss = pnl <= policyExit.hardStopLossPct;
  const takeProfit = policyExit.immediateTakeProfitPct != null && pnl >= policyExit.immediateTakeProfitPct;
  const trailingStop = policyExit.trailingDropPct > 0
    && peak >= policyExit.trailingTriggerPct
    && pnl <= peak - policyExit.trailingDropPct;
  const profitSweepEligible = policyExit.profitSweepPct > 0 && pnl >= policyExit.profitSweepPct;

  return {
    hardCutLoss,
    hardStopLoss,
    takeProfit,
    trailingStop,
    profitSweepEligible,
    hardCutLossReason: hardCutLoss
      ? `Hard Cut Loss: ${pnl.toFixed(2)}% (CL ${policyExit.hardCutLossPct.toFixed(0)}%)`
      : null,
    hardStopLossReason: hardStopLoss
      ? `Stop Loss: ${pnl.toFixed(2)}% (SL ${policyExit.hardStopLossPct.toFixed(0)}%)`
      : null,
    takeProfitReason: takeProfit
      ? `Immediate TP: ${pnl.toFixed(2)}% (TP ${policyExit.immediateTakeProfitPct.toFixed(0)}%)`
      : null,
    trailingStopReason: trailingStop
      ? `Trailing Stop: peak ${peak.toFixed(2)}% -> current ${pnl.toFixed(2)}% (dropped > ${policyExit.trailingDropPct}%)`
      : null,
    profitSweepReason: profitSweepEligible
      ? `Profit sweep eligible: ${pnl.toFixed(2)}% >= ${policyExit.profitSweepPct.toFixed(0)}%`
      : null,
  };
}

export function describeRiskPolicy(policy = buildRiskPolicy()) {
  return {
    entry: {
      hardBlockRugScore: policy.entry.hardBlockRugScore,
      shadowConfidenceFloor: policy.entry.shadowConfidenceFloor,
      probeConfidenceFloor: policy.entry.probeConfidenceFloor,
      probeCautionThreshold: policy.entry.probeCautionThreshold,
      activeConfidenceFloor: policy.entry.activeConfidenceFloor,
      flagTolerance: policy.entry.flagTolerance,
    },
    sizing: {
      minFraction: policy.sizing.minFraction,
      maxFraction: policy.sizing.maxFraction,
      probeSizeFraction: policy.sizing.probeSizeFraction,
    },
    exit: {
      hardStopLossPct: policy.exit.hardStopLossPct,
      hardCutLossPct: policy.exit.hardCutLossPct,
      immediateTakeProfitPct: policy.exit.immediateTakeProfitPct,
      trailingTriggerPct: policy.exit.trailingTriggerPct,
      trailingDropPct: policy.exit.trailingDropPct,
      profitSweepPct: policy.exit.profitSweepPct,
    },
    rug: { ...policy.rug },
  };
}
