/**
 * Portfolio Manager — Phase 2 (OpenClaw multi-strategy).
 *
 * Runs N *active* strategy-skills in PARALLEL as an ensemble, instead of the
 * orchestrator's single rotated `_activeStrategy`. For each screening candidate
 * every active skill (from the strategy-skill registry) emits a weighted vote;
 * the votes aggregate into one ensemble decision; capital is then allocated per
 * skill via the Kelly position sizer + a per-skill risk budget, bounded by the
 * global position limit and a narrative-cluster correlation guard.
 *
 * Safety (mirrors the gmgn.* staged-flag pattern):
 *   - config.portfolio.enabled defaults OFF — the live single-strategy path is
 *     untouched until an operator opts in.
 *   - Even when enabled it starts in mode "shadow": decisions are computed and
 *     logged for comparison but `actionable` is always false. Only mode
 *     "active" (flip behind an experiment_id per CLAUDE.md) lets the book vote
 *     a BUY the caller may act on.
 *
 * Per-skill P&L attribution (which skills voted for a trade + its outcome) is
 * persisted here so Phase 3's self-improvement loop and the backtest scorecard
 * can credit/blame individual skills. It is a distinct axis from
 * trade-attribution.js (pick/timing/execution cause attribution).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { listStrategySkills, setStrategySkillWeight } from "../strategy-skills.js";
import { computeKellyPositions } from "../tools/position-limits.js";
import { atomicWriteJson, withFileLock } from "../atomic-write.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTR_FILE = process.env.PONYOU_SKILL_ATTRIBUTION_FILE
  || path.join(__dirname, "..", "skill-attribution.json");

// ─── The portfolio book ───────────────────────────────────────

/**
 * The set of skills the portfolio runs in parallel, with normalized weights.
 * Active skills (status "active", weight > 0) form the live book. In shadow
 * mode `shadow`-status skills are also included so the loop can paper-trade
 * them — but they never receive real capital (allocation is gated on `active`).
 *
 * @returns {{ skills: Array, totalWeight: number, mode: string }}
 */
export function getPortfolioBook({ includeShadow = null } = {}) {
  const mode = config.portfolio?.mode === "active" ? "active" : "shadow";
  // In shadow mode we always include shadow skills (that's the point — paper
  // them); in active mode only when explicitly asked.
  const withShadow = includeShadow == null ? mode === "shadow" : includeShadow;

  const active = listStrategySkills({ status: "active" }).filter(s => (s.weight || 0) > 0);
  const shadow = withShadow ? listStrategySkills({ status: "shadow" }) : [];

  // Weights are normalized over ACTIVE skills only — shadow skills paper-trade
  // at zero capital weight, so they never dilute live allocation.
  const activeWeightSum = active.reduce((sum, s) => sum + (s.weight || 0), 0) || 1;

  const skills = [
    ...active.map(s => ({
      id: s.id,
      status: "active",
      weight: s.weight || 0,
      normWeight: (s.weight || 0) / activeWeightSum,
      params: s.params || {},
    })),
    ...shadow.map(s => ({
      id: s.id,
      status: "shadow",
      weight: s.weight || 0,
      normWeight: 0, // paper only — never gets capital
      params: s.params || {},
    })),
  ];

  return { skills, totalWeight: activeWeightSum, mode };
}

// ─── Per-skill filter evaluation ──────────────────────────────

/**
 * Apply a strategy-skill's `params.filters` against a candidate. Graceful by
 * design (the gmgn-degradation lesson): a filter only fails when the candidate
 * carries the relevant field AND it violates the bound — missing data never
 * fails a candidate, so a sparsely-enriched token isn't silently rejected.
 *
 * @returns {{ passed: boolean, reasons: string[] }}
 */
export function evaluateSkillFilters(skill, candidate = {}) {
  const f = skill?.params?.filters || {};
  const reasons = [];

  // General mcap range (min/max_mcap_usd) — gates the candidate's current mcap.
  const mcap = num(candidate.mcap_usd ?? candidate.mcap ?? candidate.market_cap);
  if (mcap != null) {
    if (f.min_mcap_usd != null && mcap < f.min_mcap_usd) reasons.push(`mcap ${mcap} < min ${f.min_mcap_usd}`);
    if (f.max_mcap_usd != null && mcap > f.max_mcap_usd) reasons.push(`mcap ${mcap} > max ${f.max_mcap_usd}`);
  }
  // maxEntryPumpMc is a SEPARATE early-entry gate on the mcap AT ENTRY/PUMP, not
  // the general range — several presets set min_mcap_usd above maxEntryPumpMc,
  // so conflating them would make those skills unsatisfiable. Only checked when
  // the candidate actually carries an entry/pump mcap field (graceful otherwise).
  const entryMcap = num(candidate.entry_pump_mcap ?? candidate.pump_mcap ?? candidate.mcap_at_entry);
  if (entryMcap != null && f.maxEntryPumpMc != null && entryMcap > f.maxEntryPumpMc) {
    reasons.push(`entry mcap ${entryMcap} > maxEntryPumpMc ${f.maxEntryPumpMc}`);
  }

  const holders = num(candidate.holders ?? candidate.holder_count);
  if (holders != null && f.min_holders != null && holders < f.min_holders) {
    reasons.push(`holders ${holders} < min ${f.min_holders}`);
  }

  const ageHours = num(candidate.age_hours ?? (candidate.age_minutes != null ? candidate.age_minutes / 60 : null));
  // minHolderAgeHours is a holder-maturity gate for swing/established strategies.
  // Early-entry (scalping/degen) strategies target brand-new pairs — applying a 24h
  // floor there makes the filter unsatisfiable and zeroes the entire ensemble.
  const isEarlyEntryStrategy = f.maxEntryPumpMc != null && f.maxEntryPumpMc <= 5000;
  if (ageHours != null && f.minHolderAgeHours != null && !isEarlyEntryStrategy && ageHours < f.minHolderAgeHours) {
    reasons.push(`age ${ageHours.toFixed(1)}h < min ${f.minHolderAgeHours}h`);
  }

  const flags = num(candidate.flags_count ?? candidate.rug_flags ?? (Array.isArray(candidate.flags) ? candidate.flags.length : null));
  if (flags != null && f.maxAllowedFlags != null && flags > f.maxAllowedFlags) {
    reasons.push(`flags ${flags} > maxAllowed ${f.maxAllowedFlags}`);
  }

  return { passed: reasons.length === 0, reasons };
}

/**
 * A single skill's vote on a candidate: it endorses the candidate's base signal
 * score iff the candidate clears the skill's filters, else votes 0.
 */
export function evaluateSkillSignal(skill, candidate, baseSignalScore) {
  const base = clamp(num(baseSignalScore) ?? 0, 0, 100);
  const { passed, reasons } = evaluateSkillFilters(skill, candidate);
  return {
    skillId: skill.id,
    status: skill.status,
    passed,
    vote: passed ? base : 0,
    normWeight: skill.normWeight || 0,
    reasons,
  };
}

// ─── Ensemble aggregation ─────────────────────────────────────

/**
 * Aggregate the book's per-skill votes into one ensemble decision.
 *
 * ensembleScore = Σ(vote_i · normWeight_i) over ACTIVE skills — non-passers
 * contribute 0, so low agreement naturally drags the score down. The book votes
 * BUY only when enough active skills agree (minAgree) AND the weighted score
 * clears minEnsembleScore.
 *
 * @returns {{ ensembleScore, agreeCount, activeCount, perSkill, summary }}
 */
export function aggregatePortfolioSignal({ candidate = {}, baseSignal = 0, book = null } = {}) {
  const b = book || getPortfolioBook();
  const minAgree = num(config.portfolio?.minAgree) ?? 2;
  const minScore = num(config.portfolio?.minEnsembleScore) ?? 55;

  const perSkill = b.skills.map(s => evaluateSkillSignal(s, candidate, baseSignal));
  const activeVotes = perSkill.filter(v => v.status === "active");
  const passers = activeVotes.filter(v => v.passed);

  const ensembleScore = clamp(
    activeVotes.reduce((sum, v) => sum + v.vote * v.normWeight, 0),
    0, 100
  );
  const agreeCount = passers.length;
  const activeCount = activeVotes.length;

  let summary;
  if (activeCount === 0) summary = "no_book";
  else if (agreeCount >= minAgree && ensembleScore >= minScore) summary = "buy";
  else if (agreeCount >= 1 && ensembleScore >= minScore * 0.6) summary = "probe";
  else summary = "skip";

  return {
    ensembleScore: round1(ensembleScore),
    agreeCount,
    activeCount,
    minAgree,
    minEnsembleScore: minScore,
    perSkill,
    summary,
  };
}

// ─── Correlation guard ────────────────────────────────────────

/**
 * Narrative-cluster correlation guard. Memecoins in the same narrative move
 * together, so the book caps concurrent open positions per cluster
 * (config.portfolio.maxPerCluster). Reuses the same narrative-tag matching the
 * decision-workflow already does for `same_narrative_count`.
 *
 * @returns {{ cluster, sameClusterCount, maxPerCluster, allowed, reason }}
 */
export function assessCorrelation({ candidate = {}, openPositions = [], maxPerCluster = null } = {}) {
  const cap = num(maxPerCluster) ?? num(config.portfolio?.maxPerCluster) ?? 2;
  const tags = narrativeTagsOf(candidate);
  const cluster = tags[0] || "OTHER";

  const sameClusterCount = (openPositions || []).filter(p => {
    const ptags = narrativeTagsOf(p);
    return tags.some(t => ptags.includes(t));
  }).length;

  const allowed = sameClusterCount < cap;
  return {
    cluster,
    sameClusterCount,
    maxPerCluster: cap,
    allowed,
    reason: allowed ? "ok" : `cluster "${cluster}" at capacity ${sameClusterCount}/${cap}`,
  };
}

// ─── Capital allocation ───────────────────────────────────────

/**
 * Allocate deployable capital across the active skills that voted BUY. Each
 * skill's share = normWeight × per-skill risk budget × Kelly fraction, scaled
 * by the available wallet capital and bounded by deploy floor/ceil. Bounded by
 * the global position limit (config.risk.maxPositions) and available slots.
 *
 * @returns {{ slotsAvailable, totalSizeSol, allocations: Array, reason }}
 */
export function allocatePortfolioCapital({ ensemble = null, book = null, walletSol = 0, openPositions = [] } = {}) {
  const b = book || getPortfolioBook();
  const e = ensemble || { perSkill: [] };
  const riskBudget = num(config.portfolio?.perSkillRiskBudget) ?? 0.5;
  const maxPositions = num(config.risk?.maxPositions) ?? 2;
  const floor = num(config.management?.deployAmountSol) ?? 0.1;
  const ceil = num(config.risk?.maxDeployAmount) ?? 35;

  const slotsAvailable = Math.max(0, maxPositions - (openPositions?.length || 0));
  if (slotsAvailable <= 0) {
    return { slotsAvailable: 0, totalSizeSol: 0, allocations: [], reason: "no_slots" };
  }

  // Only active skills that passed the candidate's filters get capital.
  const passingActive = (e.perSkill || []).filter(v => v.status === "active" && v.passed);
  if (passingActive.length === 0) {
    return { slotsAvailable, totalSizeSol: 0, allocations: [], reason: "no_passing_active_skills" };
  }

  // Kelly fraction from aggregate trade history (capped at half by riskBudget).
  const kelly = computeKellyPositions({ kellyFraction: riskBudget });
  const kellyPct = clamp((kelly.kellyPct || 0) / 100, 0, 0.95) || 0.25; // fallback 25% if no data

  // Renormalize weights over the passing subset so they sum to 1.
  const wSum = passingActive.reduce((s, v) => s + (v.normWeight || 0), 0) || passingActive.length;

  const deployable = Math.max(0, num(walletSol) ?? 0) * riskBudget * kellyPct;
  const allocations = passingActive
    .slice(0, slotsAvailable) // never exceed open-position headroom
    .map(v => {
      const share = (v.normWeight || 1 / passingActive.length) / wSum;
      const raw = deployable * share;
      const sizeSol = round4(clamp(raw, 0, ceil));
      return {
        skillId: v.skillId,
        normWeight: round4(v.normWeight || 0),
        share: round4(share),
        sizeSol: sizeSol >= floor ? sizeSol : 0, // below floor = skip this skill
        kellyPct: round1(kellyPct * 100),
      };
    })
    .filter(a => a.sizeSol > 0);

  const totalSizeSol = round4(allocations.reduce((s, a) => s + a.sizeSol, 0));
  return {
    slotsAvailable,
    totalSizeSol,
    allocations,
    reason: allocations.length ? "allocated" : "below_floor",
  };
}

// ─── Top-level decision ───────────────────────────────────────

/**
 * Compute the full portfolio decision for one candidate. Wires together the
 * ensemble vote, correlation guard, and capital allocation, honoring the
 * staged enable/mode flags.
 *
 * `actionable` is true ONLY when the portfolio is enabled, mode is "active",
 * the book voted BUY, correlation allows it, and capital was allocated. In
 * shadow mode `actionable` is always false (decisions are logged for compare).
 */
export function computePortfolioDecision({ candidate = {}, baseSignal = 0, walletSol = 0, openPositions = [] } = {}) {
  if (!config.portfolio?.enabled) {
    return { active: false, mode: "off", actionable: false, reason: "portfolio_disabled" };
  }

  // Always include shadow skills (at weight 0) so they accrue PAPER attribution
  // toward promotion even while the live book trades — they never affect the
  // active-only ensemble gate or capital allocation.
  const book = getPortfolioBook({ includeShadow: true });
  const mode = book.mode;
  const ensemble = aggregatePortfolioSignal({ candidate, baseSignal, book });
  const correlation = assessCorrelation({ candidate, openPositions });

  const wantsBuy = ensemble.summary === "buy";
  let allocation = { slotsAvailable: Math.max(0, (num(config.risk?.maxPositions) ?? 2) - openPositions.length), totalSizeSol: 0, allocations: [], reason: "not_buy" };
  if (wantsBuy && correlation.allowed) {
    allocation = allocatePortfolioCapital({ ensemble, book, walletSol, openPositions });
  } else if (wantsBuy && !correlation.allowed) {
    allocation.reason = "correlation_blocked";
  }

  const canAct = wantsBuy && correlation.allowed && allocation.allocations.length > 0;
  const actionable = mode === "active" && canAct;

  const decision = {
    active: true,
    mode,
    actionable,
    decision: wantsBuy ? (correlation.allowed ? (allocation.allocations.length ? "buy" : "buy_no_capital") : "buy_correlated") : ensemble.summary,
    ensemble,
    correlation,
    allocation,
    candidate: { mint: candidate.mint || null, symbol: candidate.symbol || null },
  };

  log("portfolio",
    `${decision.candidate.symbol || decision.candidate.mint?.slice(0, 8) || "?"} `
    + `[${mode}] ${decision.decision} `
    + `ens=${ensemble.ensembleScore} agree=${ensemble.agreeCount}/${ensemble.activeCount} `
    + `cluster=${correlation.cluster}(${correlation.sameClusterCount}/${correlation.maxPerCluster}) `
    + `cap=${allocation.totalSizeSol}SOL actionable=${actionable}`
  );

  return decision;
}

// ─── Book rebalancing (orchestrator) ──────────────────────────

/**
 * Recompute active-skill weights from their live/paper expectancy. Skills with
 * fewer than `minSample` closed trades are NOT judged (weight held). Among
 * judged skills the pooled weight is reallocated proportional to a performance
 * score (positive expectancy wins; a small base keeps a losing-but-sampled
 * skill from instantly zeroing), with each move capped at `maxStep` to damp
 * whiplash. All active weights are renormalized to sum 1. Pure — returns the
 * proposed changes without applying them.
 *
 * @returns {Array<{ id, from, to, changed, reason, expectancyPct?, trades? }>}
 */
export function computeRebalancedWeights({ book = null, attributionFn = getSkillAttribution, minSample = null, maxStep = null } = {}) {
  const b = book || getPortfolioBook();
  const active = b.skills.filter(s => s.status === "active");
  if (active.length === 0) return [];
  const ms = num(minSample) ?? num(config.portfolio?.rebalanceMinSample) ?? 20;
  const step = num(maxStep) ?? num(config.portfolio?.rebalanceMaxStep) ?? 0.1;

  const judged = [];
  const held = [];
  for (const s of active) {
    const attr = attributionFn(s.id) || {};
    const entry = { id: s.id, current: s.weight || 0, attr };
    ((attr.trades || 0) >= ms ? judged : held).push(entry);
  }

  // Nothing has enough sample yet → leave the book untouched.
  if (judged.length === 0) {
    return active.map(s => ({ id: s.id, from: s.weight || 0, to: s.weight || 0, changed: false, reason: "insufficient_sample" }));
  }

  const pool = judged.reduce((sum, e) => sum + e.current, 0);
  const scores = judged.map(e => Math.max(0, e.attr.expectancyPct || 0) + 0.05); // base avoids all-zero
  const scoreSum = scores.reduce((a, c) => a + c, 0) || judged.length;

  const results = [];
  judged.forEach((e, i) => {
    const target = pool * (scores[i] / scoreSum);
    const to = clamp(e.current + clamp(target - e.current, -step, step), 0, 1);
    results.push({ id: e.id, from: e.current, to, changed: Math.abs(to - e.current) > 1e-9, reason: "rebalanced", expectancyPct: round1(e.attr.expectancyPct || 0), trades: e.attr.trades || 0 });
  });
  for (const e of held) {
    results.push({ id: e.id, from: e.current, to: e.current, changed: false, reason: "insufficient_sample" });
  }

  // Renormalize all active weights to a proper [0,1] allocation summing to 1.
  const sum = results.reduce((a, r) => a + r.to, 0) || 1;
  for (const r of results) r.to = round4(r.to / sum);
  return results;
}

/**
 * Apply a rebalance to the registry. Only runs when the portfolio is enabled.
 * Adjusts ONLY the registry weights the PortfolioManager consumes — it never
 * opens a trade, and (since decisions are actionable only in mode "active")
 * has no live effect while the book is in shadow.
 */
export function rebalancePortfolioBook(opts = {}) {
  if (!config.portfolio?.enabled) return { applied: false, reason: "portfolio_disabled", changes: [] };
  const changes = computeRebalancedWeights(opts);
  let applied = 0;
  for (const c of changes) {
    if (c.changed) { setStrategySkillWeight(c.id, c.to); applied++; }
  }
  if (applied > 0) log("portfolio", `rebalance: ${applied}/${changes.length} active skills reweighted`);
  return { applied: applied > 0, count: applied, changes };
}

// ─── Per-skill P&L attribution ────────────────────────────────

function loadAttribution() {
  if (!fs.existsSync(ATTR_FILE)) return { entries: [], bySkill: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(ATTR_FILE, "utf8"));
    return parsed && typeof parsed === "object" && parsed.bySkill ? parsed : { entries: [], bySkill: {} };
  } catch {
    return { entries: [], bySkill: {} };
  }
}

/**
 * Record a closed trade's outcome against the skills that voted for it. Feeds
 * Phase 3 (self-improvement loop) and the per-skill scorecard.
 *
 * @param {Object} entry
 * @param {string[]} entry.skillIds  - skills that voted BUY for this trade
 * @param {number}   entry.pnlPct    - realized P&L %
 */
export async function recordSkillAttribution(entry = {}) {
  const skillIds = Array.isArray(entry.skillIds) ? entry.skillIds.filter(Boolean) : [];
  if (skillIds.length === 0) return;
  return withFileLock(ATTR_FILE, async () => {
    const store = loadAttribution();
    const pnl = Number.isFinite(Number(entry.pnlPct)) ? Number(entry.pnlPct) : null;
    const win = entry.win ?? (pnl != null ? pnl > 0 : null);
    store.entries.push({
      ts: new Date().toISOString(),
      mint: entry.mint || null,
      symbol: entry.symbol || null,
      skillIds,
      pnl_pct: pnl,
      win,
    });
    if (store.entries.length > 1000) store.entries = store.entries.slice(-1000);

    for (const id of skillIds) {
      const s = store.bySkill[id] || { trades: 0, wins: 0, losses: 0, sumPnlPct: 0 };
      s.trades += 1;
      if (win === true) s.wins += 1;
      else if (win === false) s.losses += 1;
      if (pnl != null) s.sumPnlPct = round4(s.sumPnlPct + pnl);
      store.bySkill[id] = s;
    }
    atomicWriteJson(ATTR_FILE, store);
  });
}

/** Per-skill attribution rollup: win rate + expectancy, for scorecards/loop. */
export function getSkillAttribution(skillId = null) {
  const store = loadAttribution();
  const summarize = (s) => ({
    trades: s.trades,
    wins: s.wins,
    losses: s.losses,
    winRate: s.trades ? round4(s.wins / s.trades) : 0,
    expectancyPct: s.trades ? round1(s.sumPnlPct / s.trades) : 0,
  });
  if (skillId) {
    const s = store.bySkill[skillId];
    return s ? summarize(s) : { trades: 0, wins: 0, losses: 0, winRate: 0, expectancyPct: 0 };
  }
  const out = {};
  for (const [id, s] of Object.entries(store.bySkill)) out[id] = summarize(s);
  return out;
}

// ─── Dashboard surface ────────────────────────────────────────

/** Snapshot for /api/portfolio (Phase 2 observability). */
export function getPortfolioDashboard() {
  const book = getPortfolioBook();
  return {
    enabled: !!config.portfolio?.enabled,
    mode: book.mode,
    minAgree: num(config.portfolio?.minAgree) ?? 2,
    minEnsembleScore: num(config.portfolio?.minEnsembleScore) ?? 55,
    maxPerCluster: num(config.portfolio?.maxPerCluster) ?? 2,
    perSkillRiskBudget: num(config.portfolio?.perSkillRiskBudget) ?? 0.5,
    book: book.skills.map(s => ({ id: s.id, status: s.status, weight: s.weight, normWeight: round4(s.normWeight) })),
    attribution: getSkillAttribution(),
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round1(v) { return Math.round(v * 10) / 10; }
function round4(v) { return Math.round(v * 1e4) / 1e4; }

function narrativeTagsOf(obj = {}) {
  const tags = [];
  const raw = obj.narrative_tags;
  if (Array.isArray(raw)) {
    for (const t of raw) {
      const name = typeof t === "string" ? t : t?.narrative;
      if (name) tags.push(name);
    }
  }
  const cluster = obj.conviction?.narrative_cluster?.narrative || obj.narrative_cluster || obj.narrative;
  if (cluster && !tags.includes(cluster)) tags.push(cluster);
  return tags;
}

/** Test helper — wipe the attribution store (never call in runtime). */
export function _resetSkillAttributionForTests() {
  try { if (fs.existsSync(ATTR_FILE)) fs.unlinkSync(ATTR_FILE); } catch {}
}

export default {
  getPortfolioBook,
  evaluateSkillFilters,
  evaluateSkillSignal,
  aggregatePortfolioSignal,
  assessCorrelation,
  allocatePortfolioCapital,
  computePortfolioDecision,
  computeRebalancedWeights,
  rebalancePortfolioBook,
  recordSkillAttribution,
  getSkillAttribution,
  getPortfolioDashboard,
};
