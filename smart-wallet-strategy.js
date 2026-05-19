import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMarketIntelligence } from "./market-intelligence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBSERVATION_FILE = path.join(__dirname, "observed-tokens.json");

const CONDITION_PROFILES = {
  EXTREME: {
    minScore: 82,
    minTrades: 14,
    minWinrate: 0.72,
    minRealizedPnlSol: 1.2,
    maxAvgHoldSeconds: 5_400,
    baseSizeMultiplier: 0.2,
    cooldownMinutes: 120,
  },
  HOT: {
    minScore: 74,
    minTrades: 10,
    minWinrate: 0.68,
    minRealizedPnlSol: 0.8,
    maxAvgHoldSeconds: 7_200,
    baseSizeMultiplier: 0.45,
    cooldownMinutes: 60,
  },
  NORMAL: {
    minScore: 70,
    minTrades: 9,
    minWinrate: 0.66,
    minRealizedPnlSol: 0.6,
    maxAvgHoldSeconds: 7_200,
    baseSizeMultiplier: 0.35,
    cooldownMinutes: 90,
  },
  COLD: {
    minScore: 78,
    minTrades: 12,
    minWinrate: 0.7,
    minRealizedPnlSol: 1.0,
    maxAvgHoldSeconds: 10_800,
    baseSizeMultiplier: 0.2,
    cooldownMinutes: 180,
  },
  DEAD: {
    minScore: 999,
    minTrades: 999,
    minWinrate: 0.95,
    minRealizedPnlSol: 5,
    maxAvgHoldSeconds: 3_600,
    baseSizeMultiplier: 0,
    cooldownMinutes: 240,
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function loadObservationSummary() {
  if (!fs.existsSync(OBSERVATION_FILE)) {
    return {
      reviewed: 0,
      gems: 0,
      trash: 0,
      rugs: 0,
      confidence: 0.2,
      gem_ratio: 0,
      trash_ratio: 0,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(OBSERVATION_FILE, "utf8"));
    const observed = Array.isArray(parsed?.observed) ? parsed.observed : [];
    const completed = observed.filter(entry => entry.status === "COMPLETED");
    const gems = completed.filter(entry => entry.performance === "GEM").length;
    const trash = completed.filter(entry => entry.performance === "TRASH").length;
    const rugs = completed.filter(entry => entry.performance === "RUG").length;
    const reviewed = completed.length;
    return {
      reviewed,
      gems,
      trash,
      rugs,
      confidence: clamp(reviewed / 40, 0.2, 1),
      gem_ratio: reviewed > 0 ? gems / reviewed : 0,
      trash_ratio: reviewed > 0 ? (trash + rugs) / reviewed : 0,
    };
  } catch {
    return {
      reviewed: 0,
      gems: 0,
      trash: 0,
      rugs: 0,
      confidence: 0.2,
      gem_ratio: 0,
      trash_ratio: 0,
    };
  }
}

function getProfile(condition = "NORMAL") {
  return CONDITION_PROFILES[condition] || CONDITION_PROFILES.NORMAL;
}

export function getAdaptiveSmartWalletContext(overrides = {}) {
  const market = overrides.market || getMarketIntelligence();
  const observationSummary = overrides.observationSummary || loadObservationSummary();
  const marketCondition = overrides.marketCondition || market?.condition || "NORMAL";
  const profile = getProfile(marketCondition);

  let minScore = profile.minScore;
  let cautionBias = 0;

  if (observationSummary.reviewed < 10) {
    minScore += 4;
    cautionBias += 8;
  } else if (observationSummary.reviewed >= 40 && observationSummary.gem_ratio > observationSummary.trash_ratio) {
    minScore -= 3;
  }

  if (observationSummary.trash_ratio >= 0.45) {
    minScore += 5;
    cautionBias += 10;
  }

  return {
    marketCondition,
    market,
    observationSummary,
    profile: {
      ...profile,
      minScore,
      cautionBias,
    },
    enoughData: observationSummary.reviewed >= 15,
  };
}

export function evaluateSmartWalletCandidate(candidate, contextInput = {}) {
  const context = contextInput.profile ? contextInput : getAdaptiveSmartWalletContext(contextInput);
  const stats = candidate?.stats || candidate || {};
  const profile = context.profile;
  const reasons = [];

  if (context.marketCondition === "DEAD") {
    return {
      selected: false,
      score: 0,
      confidence: round(20 * context.observationSummary.confidence),
      follow_mode: "skip",
      size_multiplier: 0,
      cooldown_minutes: profile.cooldownMinutes,
      reasons: ["Market DEAD, entry baru sebaiknya ditunda"],
      data_points: stats.completed_trades || 0,
      market_condition: context.marketCondition,
    };
  }

  if (candidate?.bot_filter) reasons.push(`Bot-like behavior: ${candidate.bot_filter}`);

  const completedTrades = Number(stats.completed_trades || 0);
  const winrate = Number(stats.winrate || 0);
  const realizedPnlSol = Number(stats.realized_pnl_sol || 0);
  const avgHoldSeconds = Number(stats.avg_hold_seconds || 0);
  const uniqueTokens = Number(stats.unique_tokens || 0);
  const focusRatio = completedTrades > 0 ? uniqueTokens / completedTrades : 99;

  const sampleScore = clamp((completedTrades / Math.max(profile.minTrades, 1)) * 18, 0, 18);
  const winrateScore = clamp(((winrate - 0.5) / 0.3) * 32, 0, 32);
  const pnlScore = clamp((realizedPnlSol / Math.max(profile.minRealizedPnlSol * 2, 0.1)) * 20, 0, 20);

  let disciplineScore = 0;
  if (avgHoldSeconds >= 90 && avgHoldSeconds <= profile.maxAvgHoldSeconds) disciplineScore = 14;
  else if (avgHoldSeconds >= 45 && avgHoldSeconds <= profile.maxAvgHoldSeconds * 1.25) disciplineScore = 10;
  else if (avgHoldSeconds > 0) disciplineScore = 4;

  const convictionScore = clamp((1.6 - Math.min(focusRatio, 1.6)) * 10, 0, 10);
  let score = sampleScore + winrateScore + pnlScore + disciplineScore + convictionScore;

  if (completedTrades < profile.minTrades) {
    score -= 12;
    reasons.push(`Trades belum cukup (${completedTrades} < ${profile.minTrades})`);
  }
  if (winrate < profile.minWinrate) {
    score -= 14;
    reasons.push(`Winrate terlalu rendah (${round(winrate * 100, 1)}% < ${round(profile.minWinrate * 100, 1)}%)`);
  }
  if (realizedPnlSol < profile.minRealizedPnlSol) {
    score -= 10;
    reasons.push(`Realized PnL terlalu kecil (${round(realizedPnlSol)} SOL < ${profile.minRealizedPnlSol} SOL)`);
  }
  if (avgHoldSeconds > profile.maxAvgHoldSeconds) {
    score -= 10;
    reasons.push(`Holding terlalu lama (${avgHoldSeconds}s > ${profile.maxAvgHoldSeconds}s)`);
  }
  if (avgHoldSeconds > 0 && avgHoldSeconds < 45) {
    score -= 16;
    reasons.push("Holding terlalu cepat, indikasi MEV/FOMO");
  }
  if (focusRatio > 1.35) {
    score -= 8;
    reasons.push(`Terlalu menyebar (${round(focusRatio)} token/trade)`);
  }
  if (!context.enoughData) {
    score -= 6;
    reasons.push("Data observasi market belum cukup, mode hati-hati");
  }
  if (context.observationSummary.trash_ratio > context.observationSummary.gem_ratio) {
    score -= 5;
    reasons.push("Market akhir-akhir ini lebih banyak trash/rug daripada gem");
  }

  score -= profile.cautionBias || 0;
  score = clamp(score, 0, 100);

  const hardReject =
    !!candidate?.bot_filter ||
    completedTrades < Math.max(3, Math.floor(profile.minTrades * 0.7)) ||
    winrate < 0.58 ||
    avgHoldSeconds > profile.maxAvgHoldSeconds * 1.75;

  const selected = !hardReject && score >= profile.minScore;
  const confidence = round(clamp(
    35 +
    completedTrades * 2 +
    context.observationSummary.confidence * 20 +
    (selected ? 10 : 0),
    0,
    100
  ));

  let followMode = "shadow";
  if (selected && score >= profile.minScore + 10 && confidence >= 75) followMode = "active";
  else if (selected) followMode = "probe";

  const sizeMultiplier = followMode === "active"
    ? profile.baseSizeMultiplier
    : followMode === "probe"
      ? round(profile.baseSizeMultiplier * 0.5)
      : 0;

  if (selected && reasons.length === 0) {
    reasons.push("Wallet lolos seleksi adaptif dengan disiplin dan edge yang cukup");
  }

  return {
    selected,
    score: round(score),
    confidence,
    follow_mode: followMode,
    size_multiplier: sizeMultiplier,
    cooldown_minutes: profile.cooldownMinutes,
    reasons,
    data_points: completedTrades,
    market_condition: context.marketCondition,
  };
}

export function selectSmartWalletCandidates(candidates = [], contextInput = {}) {
  const context = contextInput.profile ? contextInput : getAdaptiveSmartWalletContext(contextInput);
  return candidates
    .map(candidate => ({
      ...candidate,
      selection: candidate.selection || evaluateSmartWalletCandidate(candidate, context),
    }))
    .sort((a, b) => (b.selection?.score || 0) - (a.selection?.score || 0));
}
