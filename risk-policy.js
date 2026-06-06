import { normalizeRegime } from "./market-regime.js";
import { log } from "./logger.js";

const DEFAULT_POLICY = Object.freeze({
  entry: {
    hardBlockRugScore: 30,
    shadowConfidenceFloor: 25,
    probeConfidenceFloor: 40,
    probeCautionThreshold: 25,
    activeConfidenceFloor: 50,
    flagTolerance: 0,
  },
  sizing: {
    minFraction: 0,
    maxFraction: 0.20,
    probeSizeFraction: 0.05,
    hotBoost: 0.10,
    coldPenalty: 0.10,
  },
  exit: {
    hardStopLossPct: -12,
    hardCutLossPct: -22,
    immediateTakeProfitPct: null,
    trailingTriggerPct: 5,
    trailingDropPct: 5,
    trailingDropMode: "absolute",
    profitSweepPct: 35,
  },
  rug: {
    seedHardBlock: true,
    learnedSoftByDefault: true,
    learnedConfidenceFloor: 0.85,
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
    // HOT: pumps are fast, dumps are faster. Tighten exits, cap sizing.
    policy.entry.probeCautionThreshold = 28;
    policy.entry.probeConfidenceFloor = 32;
    policy.entry.activeConfidenceFloor = 45;
    policy.sizing.probeSizeFraction = 0.20;
    policy.sizing.hotBoost = 0.10;
    policy.exit.hardStopLossPct = -22;
    policy.exit.hardCutLossPct = -30;
    policy.exit.trailingTriggerPct = 7;
    policy.exit.trailingDropPct = 10;
    policy.exit.profitSweepPct = 55;
  } else if (condition === "COLD") {
    // COLD: volume thin, spreads wide. Be MORE restrictive, not less.
    // Higher conviction floor, smaller sizing, tighter stops.
    policy.entry.probeCautionThreshold = 28;
    policy.entry.probeConfidenceFloor = 42;
    policy.entry.activeConfidenceFloor = 55;
    policy.sizing.probeSizeFraction = 0.15;
    policy.sizing.coldPenalty = 0.20;
    policy.exit.hardStopLossPct = -10;
    policy.exit.hardCutLossPct = -16;
    policy.exit.trailingTriggerPct = 4;
    policy.exit.trailingDropPct = 5;
    policy.exit.profitSweepPct = 25;
  } else if (condition === "DEAD") {
    policy.entry.probeCautionThreshold = 0;
    policy.entry.probeConfidenceFloor = 100;
    policy.entry.activeConfidenceFloor = 100;
    policy.sizing.probeSizeFraction = 0;
    policy.sizing.minFraction = 0;
    policy.exit.hardStopLossPct = -3;
    policy.exit.hardCutLossPct = -5;
    policy.exit.trailingTriggerPct = 0;
    policy.exit.trailingDropPct = 0;
    policy.exit.profitSweepPct = 0;
  }
  return policy;
}

export function buildRiskPolicy({ marketCondition = "NORMAL", conviction = {}, token = {}, config = {}, strategyParams = null } = {}) {
  const condition = normalizeMarketCondition(marketCondition);
  const policy = clonePolicy();
  adjustByMarket(policy, condition);

  // ── Strategy-aware exit parameters ──────────────────────────
  // Active strategy presets define stoploss, trailing, partial TP.
  // These override the risk-policy defaults so each strategy's
  // risk profile is actually enforced at exit time.
  if (strategyParams) {
    // Stoploss from strategy (e.g., -0.15 = -15%, -0.30 = -30%)
    const stratSl = Number(strategyParams.stoploss);
    if (Number.isFinite(stratSl) && stratSl <= -0.01 && stratSl >= -0.50) {
      policy.exit.hardStopLossPct = stratSl * 100; // convert decimal to pct
    }
    // Hard cut loss = stoploss * 1.5x (strategy's intended floor below stop)
    policy.exit.hardCutLossPct = Math.max(policy.exit.hardStopLossPct * 1.6, -30);

    // Trailing stop from strategy
    if (strategyParams.trailing_stop?.enabled) {
      const offsetPct = Number(strategyParams.trailing_stop.positive_offset);
      const distPct = Number(strategyParams.trailing_stop.positive_distance);
      if (Number.isFinite(offsetPct) && offsetPct > 0) {
        policy.exit.trailingTriggerPct = offsetPct * 100;
      }
      if (Number.isFinite(distPct) && distPct > 0) {
        policy.exit.trailingDropPct = distPct * 100;
      }
    } else if (strategyParams.trailing_stop?.enabled === false) {
      // Strategy explicitly disables trailing
      policy.exit.trailingTriggerPct = 0;
      policy.exit.trailingDropPct = 0;
    }
  }

  const convictionScore = Number(conviction.conviction_score || 0);
  const convictionConfidence = Number(conviction.confidence_score || 0);
  const rugScore = Number(token.rug_score || 0);
  const flagCount = Array.isArray(token.flags) ? token.flags.length : 0;

  if (convictionScore >= 70 && convictionConfidence >= 45) {
    policy.sizing.probeSizeFraction = clamp(policy.sizing.probeSizeFraction + 0.05, 0.1, 0.6);
  }

  if (rugScore >= policy.entry.hardBlockRugScore) {
    policy.entry.flagTolerance = 0;
  } else if (rugScore >= 20) {
    policy.entry.flagTolerance = 0;
    policy.sizing.probeSizeFraction = Math.min(policy.sizing.probeSizeFraction, 0.25);
  }

  if (flagCount >= 2) {
    policy.entry.flagTolerance = 0;
    policy.sizing.probeSizeFraction = Math.min(policy.sizing.probeSizeFraction, 0.25);
  }

  const rawStop = Number.isFinite(config?.management?.stopLossPct)
    ? config.management.stopLossPct
    : policy.exit.hardStopLossPct;
  const stopLossPct = rawStop >= -50 && rawStop <= -1
    ? rawStop
    : (log("risk_policy_warn", `stopLossPct ${rawStop} out of valid range, using default`), policy.exit.hardStopLossPct);
  const takeProfitPct = Number.isFinite(config?.management?.takeProfitPct)
    ? config.management.takeProfitPct
    : Number.isFinite(config?.management?.autoTakeProfitPct)
      ? config.management.autoTakeProfitPct
      : null;

  policy.exit.hardStopLossPct = stopLossPct;
  policy.exit.immediateTakeProfitPct = takeProfitPct;
  // M2: recompute hardCutLossPct after config override so it always sits below hardStopLossPct.
  // Without this, strategy-derived cut (e.g. -19%) can end up shallower than a config stop
  // (e.g. -25%), making the cut tier fire before the stop — inverting the hierarchy.
  policy.exit.hardCutLossPct = Math.max(policy.exit.hardStopLossPct * 1.6, -30);
  if (condition === "COLD") {
    policy.exit.hardStopLossPct = Math.max(policy.exit.hardStopLossPct, -10);
    // recompute cut after cold clamp too
    policy.exit.hardCutLossPct = Math.max(policy.exit.hardStopLossPct * 1.6, -30);
    if (Number.isFinite(policy.exit.immediateTakeProfitPct)) {
      policy.exit.immediateTakeProfitPct = Math.min(policy.exit.immediateTakeProfitPct, 130);
    }
  }
  // M1: DEAD-market tight stop must not be overridden by a wider config stopLoss.
  // Without this clamp the -3% DEAD protection set by adjustByMarket is silently
  // replaced by whatever stopLossPct the operator configured (e.g. -20%).
  if (condition === "DEAD") {
    policy.exit.hardStopLossPct = Math.max(policy.exit.hardStopLossPct, -5);
    policy.exit.hardCutLossPct = Math.max(policy.exit.hardStopLossPct * 1.6, -8);
  }
  const trailingTrigger = Number.isFinite(config?.management?.trailingTriggerPct)
    ? clamp(config.management.trailingTriggerPct, 1, 30)
    : policy.exit.trailingTriggerPct;
  const trailingDrop = Number.isFinite(config?.management?.trailingDropPct)
    ? clamp(config.management.trailingDropPct, 0.5, 30)
    : policy.exit.trailingDropPct;
  policy.exit.trailingTriggerPct = trailingTrigger;
  policy.exit.trailingDropPct = trailingDrop;

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
  const trailingThreshold = policyExit.trailingDropMode === "proportional"
    ? peak * (1 - policyExit.trailingDropPct / 100)
    : peak - policyExit.trailingDropPct;
  const trailingStop = policyExit.trailingDropPct > 0
    && peak >= policyExit.trailingTriggerPct
    && pnl <= trailingThreshold + 1e-9;
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
      trailingDropMode: policy.exit.trailingDropMode,
      profitSweepPct: policy.exit.profitSweepPct,
    },
    rug: { ...policy.rug },
  };
}
