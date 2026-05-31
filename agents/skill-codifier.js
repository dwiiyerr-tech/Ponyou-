/**
 * Skill Codifier — Phase 3 (Hermes self-improvement closed loop).
 *
 * Closes the loop:
 *   outcomes → mine winning patterns → AUTHOR a loop strategy-skill →
 *   backtest (Phase 1 scorecard) → if it clears the promotion gate, register it
 *   as SHADOW (paper) → PortfolioManager paper-runs it → after a min sample,
 *   surface it for MANUAL approval → on approval, promote to `active` at a small
 *   capped weight.
 *
 * HARD GATE (locked safety decision): the loop NEVER moves a skill to live
 * capital on its own. `runCodifierCycle` only ever produces draft/shadow skills.
 * The single guarded promotion path — `promoteSkillWithApproval` — refuses unless
 * `approved === true`, and the registry itself re-checks the scorecard gate +
 * the loop-author approval flag (strategy-skills.js setStrategySkillStatus).
 *
 * Data sources mined: conviction-memory profit patterns (getProfitPatternSummary),
 * learning-agent strategy performance (getStrategyPerformance), and the
 * portfolio-manager per-skill attribution (getSkillAttribution). Reuses the
 * Phase-1 backtest scorecard (backtest.js buildScorecard) and the Phase-0
 * registry (strategy-skills.js). Backtest trade-loading is injectable so this is
 * unit-testable without the network.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { PRESETS } from "../strategies.js";
import { getProfitPatternSummary } from "../conviction-memory.js";
import { getStrategyPerformance } from "./learning-agent.js";
import { getSkillAttribution } from "./portfolio-manager.js";
import { buildScorecard, DEFAULT_COST_MODEL } from "../backtest.js";
import { buildRiskPolicy } from "../risk-policy.js";
import {
  makeStrategySkill,
  upsertStrategySkill,
  getStrategySkill,
  listStrategySkills,
  setStrategySkillScorecard,
  setStrategySkillStatus,
  setStrategySkillWeight,
  scorecardPasses,
} from "../strategy-skills.js";

// mcap_tier (conviction-memory classifyMcapTier) → filter bounds for authoring.
export const MCAP_TIER_BOUNDS = {
  nano:  { min_mcap_usd: 0,          max_mcap_usd: 50_000 },
  micro: { min_mcap_usd: 50_000,     max_mcap_usd: 500_000 },
  small: { min_mcap_usd: 500_000,    max_mcap_usd: 5_000_000 },
  mid:   { min_mcap_usd: 5_000_000,  max_mcap_usd: 50_000_000 },
  large: { min_mcap_usd: 50_000_000, max_mcap_usd: null }, // no upper bound
};

// A loop skill's preset params are cloned from this base unless the mined
// pattern points at a specific, still-registered strategy.
const DEFAULT_BASE_STRATEGY = "scalping";

// ─── 1. Mine winning patterns ─────────────────────────────────

/**
 * Identify the strongest repeatable winning setup from accumulated profit
 * patterns + strategy performance. Returns null when there isn't enough signal
 * to justify authoring a new skill.
 *
 * @returns {null | { mcapTier, narrative, baseStrategyId, sample, avgPnl, source }}
 */
export function mineWinningPatterns({ minSample = null } = {}) {
  const need = num(minSample) ?? num(config.skillLoop?.minPatternSample) ?? 5;
  const summary = getProfitPatternSummary();
  if (!summary || (summary.total || 0) < need) {
    return null;
  }

  const topTier = (summary.best_mcap_tiers || []).find(t => t.tier && t.tier !== "unknown");
  const topNarrative = (summary.best_narratives || [])[0] || null;

  // Prefer a base strategy that (a) the winning patterns actually used and
  // (b) still exists as a registered preset; else fall back to the default.
  const perf = safeArr(getStrategyPerformance());
  const bestPerf = perf.find(p => p.id && PRESETS[p.id] && (p.win_rate || 0) >= 0.5);
  const patternStrategy = (summary.best_strategies || []).find(s => s.strategy && PRESETS[s.strategy]);
  const baseStrategyId = bestPerf?.id || patternStrategy?.strategy || DEFAULT_BASE_STRATEGY;

  if (!topTier && !topNarrative) return null;

  return {
    mcapTier: topTier?.tier || null,
    narrative: topNarrative?.narrative || null,
    baseStrategyId,
    sample: summary.total,
    avgPnl: summary.avg_pnl ?? 0,
    source: "profit_patterns",
  };
}

// ─── 2. Author a loop strategy-skill ──────────────────────────

/**
 * Author (but do NOT yet register) a strategy-skill from a mined pattern.
 * Clones the base preset's params and tightens the mcap filter to the winning
 * tier. provenance.author = "loop" so the registry forces manual approval before
 * it can ever go active.
 */
export function authorSkillFromPattern(pattern = {}, { experimentId = null } = {}) {
  const baseId = pattern.baseStrategyId && PRESETS[pattern.baseStrategyId]
    ? pattern.baseStrategyId : DEFAULT_BASE_STRATEGY;
  const base = PRESETS[baseId];

  // Deep-ish clone so we never mutate the live preset object.
  const params = JSON.parse(JSON.stringify(base));
  delete params.id;
  delete params.name;
  delete params.description;
  params.filters = params.filters || {};

  if (pattern.mcapTier && MCAP_TIER_BOUNDS[pattern.mcapTier]) {
    const bounds = MCAP_TIER_BOUNDS[pattern.mcapTier];
    params.filters.min_mcap_usd = bounds.min_mcap_usd;
    if (bounds.max_mcap_usd != null) params.filters.max_mcap_usd = bounds.max_mcap_usd;
    else delete params.filters.max_mcap_usd;
  }

  const id = nextLoopSkillId(baseId, pattern.mcapTier || "any");
  return makeStrategySkill({
    id,
    version: 1,
    type: "composite",
    params,
    provenance: {
      author: "loop",
      parent_skills: [baseId],
      experiment_id: experimentId,
      note: `codified from ${pattern.source || "patterns"}: tier=${pattern.mcapTier || "-"} `
        + `narrative=${pattern.narrative || "-"} sample=${pattern.sample} avgPnl=${pattern.avgPnl}`,
    },
    status: "draft",
    weight: 0,
  });
}

/** Unique, versioned id for a loop skill (avoids clobbering an existing one). */
function nextLoopSkillId(baseId, tier) {
  const stem = `loop_${baseId}_${tier}`;
  let n = 1;
  while (getStrategySkill(`${stem}_v${n}`)) n++;
  return `${stem}_v${n}`;
}

// ─── 3. Backtest the authored skill ───────────────────────────

/**
 * Run the Phase-1 backtest scorecard for an authored skill. Trades must be
 * supplied (loaded via backtest-data/loader.loadTrades by the caller, or
 * injected in tests) so this stays pure and offline-testable. Applies the
 * skill's stoploss / first-ROI as the exit policy overrides.
 *
 * @returns {object} the backtest_scorecard
 */
export function backtestSkill(skill, { trades = [], costModel = DEFAULT_COST_MODEL, splitRatio = 0.7, marketCondition = "NORMAL" } = {}) {
  const p = skill?.params || {};
  // params.stoploss is a fraction (-0.15); risk-policy wants a percent (-15).
  const stopLossPct = Number.isFinite(p.stoploss) ? clamp(p.stoploss * 100, -50, -1) : null;
  const firstRoi = p.minimal_roi && p.minimal_roi["0"];
  const takeProfitPct = Number.isFinite(firstRoi) ? firstRoi * 100 : null;

  // Build a concrete risk policy from the skill's exit params so the backtest
  // simulates the skill's OWN stops/targets (buildScorecard forwards `policy`
  // straight to simulateTrade). Null → backtest builds its regime default.
  const policy = (stopLossPct != null || takeProfitPct != null)
    ? buildRiskPolicy({ marketCondition, config: { management: { stopLossPct, takeProfitPct } } })
    : null;

  return buildScorecard({ trades, costModel, splitRatio, marketCondition, policy });
}

// ─── 4. Propose as a shadow skill (the gate) ──────────────────

/**
 * Score the authored skill and, IF it clears the promotion gate, register it as
 * SHADOW with its scorecard attached. Never registers active. Returns a verdict.
 *
 * @returns {{ accepted, skillId, scorecard, gate, reason }}
 */
export function proposeShadowSkill(skill, scorecard) {
  const gate = scorecardPasses(scorecard);
  if (!gate.passed) {
    return { accepted: false, skillId: skill.id, scorecard, gate, reason: `gate_failed: ${gate.reasons.join("; ")}` };
  }
  // Register draft → attach scorecard → move to shadow (paper).
  upsertStrategySkill({ ...skill, status: "draft" });
  setStrategySkillScorecard(skill.id, scorecard);
  setStrategySkillStatus(skill.id, "shadow");
  log("skill_codifier", `Authored loop skill "${skill.id}" → shadow (scorecard passed)`);
  return { accepted: true, skillId: skill.id, scorecard, gate, reason: "registered_shadow" };
}

// ─── 5. Surface for manual approval ───────────────────────────

/**
 * Build an approval request for a shadow skill that has accrued enough paper
 * sample. Does NOT promote — it produces the payload a human/Telegram/Claude
 * policy gate acts on. Returns null if the skill isn't ready.
 */
export function buildApprovalRequest(skillId, { minShadowSample = null } = {}) {
  const skill = getStrategySkill(skillId);
  if (!skill || skill.status !== "shadow") return null;

  const need = num(minShadowSample) ?? num(config.skillLoop?.minShadowSample) ?? 30;
  const attribution = getSkillAttribution(skillId);
  if ((attribution.trades || 0) < need) {
    return null; // not enough paper sample yet
  }

  return {
    type: "skill_promotion_request",
    skillId,
    author: skill.provenance?.author,
    experiment_id: skill.provenance?.experiment_id || null,
    parent_skills: skill.provenance?.parent_skills || [],
    backtest_scorecard: skill.backtest_scorecard || null,
    paper_attribution: attribution,
    proposed_weight: num(config.skillLoop?.promotionMaxWeight) ?? 0.1,
    note: "Loop-authored skill ready for MANUAL promotion review. Live promotion requires approved=true.",
  };
}

// ─── 6. The single guarded promotion path ─────────────────────

/**
 * Promote an approved loop skill to `active` at a small capped weight. This is
 * the ONLY path that moves a loop skill to live capital, and it refuses unless
 * `approved === true`. The registry independently re-checks the scorecard gate
 * and the loop-author approval flag, so a bug here cannot silently promote.
 *
 * @returns {object} the updated skill
 */
export function promoteSkillWithApproval(skillId, { approved = false, weight = null } = {}) {
  if (approved !== true) {
    throw new Error(`promoteSkillWithApproval refused: live promotion of "${skillId}" requires explicit approval (approved=true)`);
  }
  const cap = num(config.skillLoop?.promotionMaxWeight) ?? 0.1;
  const w = clamp(num(weight) ?? cap, 0, cap); // never exceed the loop promotion cap
  setStrategySkillWeight(skillId, w);
  const updated = setStrategySkillStatus(skillId, "active", { approved: true });
  log("skill_codifier", `Loop skill "${skillId}" PROMOTED to active @ weight ${w} (manually approved)`);
  return updated;
}

// ─── Orchestration ────────────────────────────────────────────

/**
 * One codifier cycle: mine → author → backtest → (gate) register shadow.
 * Honors the staged enable flag and the HARD GATE (never auto-promotes). The
 * caller supplies a `loadTradesFn(skill) => trades[]` (the loader, or a stub).
 *
 * @returns {object} a report of what happened
 */
export async function runCodifierCycle({ loadTradesFn = null, minSample = null, experimentId = null } = {}) {
  if (!config.skillLoop?.enabled) {
    return { ran: false, reason: "skill_loop_disabled" };
  }

  const pattern = mineWinningPatterns({ minSample });
  if (!pattern) return { ran: true, authored: false, reason: "no_minable_pattern" };

  const skill = authorSkillFromPattern(pattern, { experimentId });

  let trades = [];
  if (typeof loadTradesFn === "function") {
    try { trades = (await loadTradesFn(skill)) || []; }
    catch (e) { return { ran: true, authored: false, reason: `load_trades_failed: ${e.message}`, pattern }; }
  }
  if (!Array.isArray(trades) || trades.length === 0) {
    return { ran: true, authored: false, reason: "no_backtest_trades", pattern, skillId: skill.id };
  }

  const scorecard = backtestSkill(skill, { trades });
  const verdict = proposeShadowSkill(skill, scorecard);

  return {
    ran: true,
    authored: verdict.accepted,
    skillId: skill.id,
    pattern,
    scorecard,
    verdict,
    // Reminder for the operator/governance layer (CLAUDE.md): open an experiment
    // for any shadow skill before it can be surfaced for live promotion.
    next: verdict.accepted ? "create_experiment + paper-run via PortfolioManager, then buildApprovalRequest" : "discarded",
  };
}

/** Dashboard surface for /api/skill-loop — shadow skills + their paper sample. */
export function getSkillLoopDashboard() {
  const shadow = listStrategySkills({ status: "shadow", author: "loop" }).map(s => ({
    id: s.id,
    parent_skills: s.provenance?.parent_skills || [],
    experiment_id: s.provenance?.experiment_id || null,
    scorecard_sample: s.backtest_scorecard?.sample ?? 0,
    paper: getSkillAttribution(s.id),
  }));
  return {
    enabled: !!config.skillLoop?.enabled,
    minPatternSample: num(config.skillLoop?.minPatternSample) ?? 5,
    minShadowSample: num(config.skillLoop?.minShadowSample) ?? 30,
    promotionMaxWeight: num(config.skillLoop?.promotionMaxWeight) ?? 0.1,
    shadowSkills: shadow,
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function safeArr(v) { return Array.isArray(v) ? v : []; }

export default {
  mineWinningPatterns,
  authorSkillFromPattern,
  backtestSkill,
  proposeShadowSkill,
  buildApprovalRequest,
  promoteSkillWithApproval,
  runCodifierCycle,
  getSkillLoopDashboard,
  MCAP_TIER_BOUNDS,
};
