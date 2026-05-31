/**
 * Strategy-Skill registry — the portable, versioned artifact that unifies the
 * four "Hermes/OpenClaw-class" axes:
 *   - the unit the self-improvement loop AUTHORS (provenance.author = "loop"),
 *   - the unit the multi-strategy PortfolioManager RUNS in parallel (weight),
 *   - the unit the internal marketplace SHIPS/VETS (computedHash in skills-lock),
 *   - promotable to "active" only behind a passing backtest_scorecard.
 *
 * It is built ON TOP of strategies.js PRESETS (not a replacement): a skill's
 * `params` is the same nested preset shape (filters / minimal_roi / stoploss /
 * trailing_stop / partial_tp / roi_presets / use_llm / staged_entry) the live
 * exit/entry logic already consumes, so a registered skill plugs straight into
 * the existing engine. The 6 built-in presets are bootstrapped as human-authored
 * `active` skills so nothing is rebuilt and getActiveStrategy() keeps working.
 *
 * Persistence:
 *   ./strategy-skills.json          — the registry { version, skills: {id: skill} }
 *   ./strategy-skills-lock.json     — gitignored sidecar holding the
 *                                     `strategySkills` hash-pin map. Kept OUT of
 *                                     the tracked skills-lock.json (owned by the
 *                                     external `skills` CLI) so runtime pins
 *                                     never churn that reproducible lockfile.
 *
 * Lifecycle: draft → shadow → active → retired.
 *   - shadow→active REQUIRES a passing backtest_scorecard (the promotion gate).
 *   - loop-authored skills additionally require manual approval before active
 *     (enforced at the promotion call site per the locked safety decision;
 *     the registry exposes `requiresApproval()` so callers can't forget).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { PRESETS, STRATEGY_IDS } from "./strategies.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Env-overridable so the test suite points these at a throwaway tmp dir and
// NEVER touches the live registry / lockfile (see vitest.config.js).
const REGISTRY_FILE = process.env.PONYOU_STRATEGY_SKILLS_FILE || path.join(__dirname, "strategy-skills.json");
const LOCK_FILE = process.env.PONYOU_SKILLS_LOCK_FILE || path.join(__dirname, "skills-lock.json");
// Strategy-skill hash-pins live in their OWN gitignored sidecar so they never
// dirty the TRACKED skills-lock.json (owned by the external `skills` CLI, which
// manages the `skills` key — that file must stay reproducible). Older builds
// wrote the `strategySkills` map INTO skills-lock.json, re-dirtying it on every
// bootstrap/rebalance; readLock() migrates+strips any such legacy pins once.
const STRATEGY_LOCK_FILE = process.env.PONYOU_STRATEGY_SKILLS_LOCK_FILE || path.join(__dirname, "strategy-skills-lock.json");

const SCHEMA_VERSION = 1;
export const SKILL_STATUSES = ["draft", "shadow", "active", "retired"];
export const SKILL_TYPES = ["signal", "exit", "filter", "composite"];

// Promotion policy — a scorecard must clear these (on out-of-sample data) before
// a skill may go `active`. Conservative by design; tune behind an experiment.
export const DEFAULT_PROMOTION_THRESHOLDS = {
  minSample: 30,            // trades in the out-of-sample window
  minExpectancyPct: 0,      // positive expected value per trade
  minWinRate: 0.35,         // memecoin strategies can be low-winrate / high-R
  maxDrawdownPct: 60,       // reject ruinous equity curves
  minSharpe: 0,             // non-negative risk-adjusted return
};

// ─── Hashing ──────────────────────────────────────────────────

/** Stable content hash over the parts that define behavior (not timestamps). */
export function computeSkillHash(skill) {
  const canonical = stableStringify({
    id: skill.id,
    version: skill.version,
    type: skill.type,
    params: skill.params,
    provenance: { author: skill.provenance?.author, parent_skills: skill.provenance?.parent_skills || [] },
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// Deterministic JSON (sorted keys) so the hash is stable across key ordering.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// ─── Construction + validation ────────────────────────────────

/**
 * Normalize a partial skill input into a full, validated Strategy-Skill.
 * Throws on invalid shape so bad artifacts never reach the registry.
 */
export function makeStrategySkill(input = {}) {
  const skill = {
    id: input.id,
    version: Number.isFinite(input.version) ? input.version : 1,
    type: input.type || "composite",
    params: input.params || {},
    provenance: {
      author: input.provenance?.author || "human",
      parent_skills: Array.isArray(input.provenance?.parent_skills) ? input.provenance.parent_skills : [],
      experiment_id: input.provenance?.experiment_id ?? null,
      created_at: input.provenance?.created_at || new Date().toISOString(),
      note: input.provenance?.note || "",
    },
    backtest_scorecard: input.backtest_scorecard ?? null,
    status: input.status || "draft",
    weight: Number.isFinite(input.weight) ? input.weight : 0,
    updated_at: new Date().toISOString(),
  };
  const { ok, errors } = validateStrategySkill(skill);
  if (!ok) throw new Error(`Invalid strategy-skill: ${errors.join("; ")}`);
  skill.hash = computeSkillHash(skill);
  return skill;
}

export function validateStrategySkill(skill) {
  const errors = [];
  if (!skill || typeof skill !== "object") return { ok: false, errors: ["not an object"] };
  if (typeof skill.id !== "string" || !skill.id.trim()) errors.push("id must be a non-empty string");
  if (!Number.isInteger(skill.version) || skill.version < 1) errors.push("version must be an integer >= 1");
  if (!SKILL_TYPES.includes(skill.type)) errors.push(`type must be one of ${SKILL_TYPES.join("|")}`);
  if (!skill.params || typeof skill.params !== "object") errors.push("params must be an object");
  if (!SKILL_STATUSES.includes(skill.status)) errors.push(`status must be one of ${SKILL_STATUSES.join("|")}`);
  if (typeof skill.weight !== "number" || skill.weight < 0 || skill.weight > 1) errors.push("weight must be a number in [0,1]");
  const author = skill.provenance?.author;
  if (author !== "human" && author !== "loop") errors.push('provenance.author must be "human" or "loop"');
  return { ok: errors.length === 0, errors };
}

// ─── Scorecard gate ───────────────────────────────────────────

/**
 * Does a backtest scorecard clear the promotion thresholds? Evaluated against
 * the OUT-OF-SAMPLE slice when present (walk-forward), else the top-level metrics.
 */
export function scorecardPasses(scorecard, thresholds = DEFAULT_PROMOTION_THRESHOLDS) {
  if (!scorecard || typeof scorecard !== "object") return { passed: false, reasons: ["no scorecard"] };
  const m = scorecard.walk_forward?.out_of_sample || scorecard.metrics || {};
  const sample = Number(scorecard.walk_forward?.out_of_sample?.sample ?? scorecard.sample ?? m.sample ?? 0);
  const reasons = [];
  if (sample < thresholds.minSample) reasons.push(`sample ${sample} < ${thresholds.minSample}`);
  if (Number(m.expectancy_pct ?? -Infinity) < thresholds.minExpectancyPct) reasons.push(`expectancy ${m.expectancy_pct} < ${thresholds.minExpectancyPct}`);
  if (Number(m.win_rate ?? -Infinity) < thresholds.minWinRate) reasons.push(`win_rate ${m.win_rate} < ${thresholds.minWinRate}`);
  if (Number(m.max_drawdown_pct ?? Infinity) > thresholds.maxDrawdownPct) reasons.push(`max_drawdown ${m.max_drawdown_pct} > ${thresholds.maxDrawdownPct}`);
  if (Number(m.sharpe ?? -Infinity) < thresholds.minSharpe) reasons.push(`sharpe ${m.sharpe} < ${thresholds.minSharpe}`);
  return { passed: reasons.length === 0, reasons };
}

// ─── Registry persistence ─────────────────────────────────────

function loadRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return { version: SCHEMA_VERSION, skills: {} };
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    if (!data || typeof data !== "object" || !data.skills) return { version: SCHEMA_VERSION, skills: {} };
    return data;
  } catch (e) {
    log("skills", `WARN: strategy-skills.json unreadable (${e.message}) — starting empty`);
    return { version: SCHEMA_VERSION, skills: {} };
  }
}

function saveRegistry(reg) {
  reg.version = SCHEMA_VERSION;
  atomicWriteJson(REGISTRY_FILE, reg);
}

export function getStrategySkill(id) {
  return loadRegistry().skills[id] || null;
}

export function listStrategySkills({ status = null, author = null } = {}) {
  const skills = Object.values(loadRegistry().skills);
  return skills.filter(s =>
    (status == null || s.status === status) &&
    (author == null || s.provenance?.author === author)
  );
}

/**
 * Validate, hash, persist, and hash-pin into skills-lock.json.
 * `source` ("local" | "imported") and optional `lockMeta` (capabilities /
 * quarantine flags from the marketplace vetting gate) are recorded in the lock
 * so an imported package is provenance-distinguishable from a native skill.
 */
export function upsertStrategySkill(input, { source = "local", lockMeta = null } = {}) {
  const skill = input.hash && validateStrategySkill(input).ok ? input : makeStrategySkill(input);
  skill.hash = computeSkillHash(skill);
  skill.updated_at = new Date().toISOString();
  const reg = loadRegistry();
  reg.skills[skill.id] = skill;
  saveRegistry(reg);
  pinSkillLock(skill, { source, lockMeta });
  return skill;
}

/**
 * Lifecycle transition with the promotion gate. shadow→active requires a passing
 * scorecard. Loop-authored skills also require `approved=true` (manual approval
 * per the locked safety decision); the registry refuses to silently promote them.
 */
export function setStrategySkillStatus(id, status, { approved = false, thresholds } = {}) {
  if (!SKILL_STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
  const reg = loadRegistry();
  const skill = reg.skills[id];
  if (!skill) throw new Error(`Unknown strategy-skill: ${id}`);

  if (status === "active") {
    // HARD RULE (ClawHub/Snyk lesson): an imported package flagged
    // execution-class at vetting is quarantined and may NEVER go active —
    // not even with manual approval. Enforced here so no call site can bypass.
    if (readLock().strategySkills?.[id]?.vetting?.quarantined === true) {
      throw new Error(`Cannot promote "${id}" to active — quarantined execution-class import (never auto-exec)`);
    }
    const gate = scorecardPasses(skill.backtest_scorecard, thresholds);
    if (!gate.passed) throw new Error(`Cannot promote "${id}" to active — scorecard gate failed: ${gate.reasons.join("; ")}`);
    if (requiresApproval(skill) && !approved) {
      throw new Error(`Cannot promote loop-authored "${id}" to active without manual approval (approved=false)`);
    }
  }

  skill.status = status;
  skill.updated_at = new Date().toISOString();
  reg.skills[id] = skill;
  saveRegistry(reg);
  log("skills", `Strategy-skill "${id}" → ${status}`);
  return skill;
}

/** Loop-authored skills require explicit human approval before going live. */
export function requiresApproval(skill) {
  return skill?.provenance?.author === "loop";
}

export function setStrategySkillScorecard(id, scorecard) {
  const reg = loadRegistry();
  const skill = reg.skills[id];
  if (!skill) throw new Error(`Unknown strategy-skill: ${id}`);
  skill.backtest_scorecard = scorecard;
  skill.updated_at = new Date().toISOString();
  reg.skills[id] = skill;
  saveRegistry(reg);
  return skill;
}

export function setStrategySkillWeight(id, weight) {
  if (typeof weight !== "number" || weight < 0 || weight > 1) throw new Error("weight must be in [0,1]");
  const reg = loadRegistry();
  const skill = reg.skills[id];
  if (!skill) throw new Error(`Unknown strategy-skill: ${id}`);
  skill.weight = weight;
  skill.updated_at = new Date().toISOString();
  reg.skills[id] = skill;
  saveRegistry(reg);
  return skill;
}

// ─── skills-lock.json hash-pinning ────────────────────────────

/** One-time migration: pull any legacy `strategySkills` map out of the tracked
 *  skills-lock.json into the gitignored sidecar, then strip it from the lock
 *  (preserving the external CLI's `skills` key). Returns the sidecar contents. */
function migrateLegacyLock() {
  const sidecar = { version: 1, strategySkills: {} };
  try {
    if (!fs.existsSync(LOCK_FILE)) return sidecar;
    const legacy = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")) || {};
    if (legacy.strategySkills && typeof legacy.strategySkills === "object") {
      sidecar.strategySkills = legacy.strategySkills;
      delete legacy.strategySkills;             // never touch the `skills` key
      atomicWriteJson(LOCK_FILE, legacy);        // clean the tracked file once
      atomicWriteJson(STRATEGY_LOCK_FILE, sidecar);
      log("skills", "Migrated strategySkills pins out of skills-lock.json into the strategy-skills-lock.json sidecar");
    }
  } catch { /* best-effort migration; fall back to an empty sidecar */ }
  return sidecar;
}

function readLock() {
  try {
    if (fs.existsSync(STRATEGY_LOCK_FILE)) {
      const lock = JSON.parse(fs.readFileSync(STRATEGY_LOCK_FILE, "utf8"));
      if (lock && typeof lock === "object") {
        if (!lock.strategySkills || typeof lock.strategySkills !== "object") lock.strategySkills = {};
        return lock;
      }
    }
  } catch { /* corrupt/missing sidecar → migrate or start fresh below */ }
  return migrateLegacyLock();
}

/** Pin a skill's hash in the strategy-skills-lock.json sidecar. Lets the
 *  marketplace/vetting layer detect tampering. `source` distinguishes native
 *  ("local") from "imported" packages; `lockMeta` carries the vetting verdict
 *  (capabilities/quarantine). Kept out of skills-lock.json to avoid churn. */
function pinSkillLock(skill, { source = "local", lockMeta = null } = {}) {
  const lock = readLock();
  if (!lock.strategySkills || typeof lock.strategySkills !== "object") lock.strategySkills = {};
  lock.strategySkills[skill.id] = {
    source,
    sourceType: source,
    version: skill.version,
    status: skill.status,
    author: skill.provenance?.author || "human",
    computedHash: skill.hash,
    ...(lockMeta ? { vetting: lockMeta } : {}),
  };
  atomicWriteJson(STRATEGY_LOCK_FILE, lock);
}

/** Read the skills-lock.json pin entry for a skill (source/vetting/hash). */
export function getSkillLockEntry(id) {
  return readLock().strategySkills?.[id] || null;
}

/** Verify a skill's current content matches its pinned hash (tamper check). */
export function verifySkillLock(id) {
  const skill = getStrategySkill(id);
  if (!skill) return { ok: false, reason: "unknown skill" };
  const pinned = readLock().strategySkills?.[id]?.computedHash;
  if (!pinned) return { ok: false, reason: "not pinned" };
  const current = computeSkillHash(skill);
  return { ok: pinned === current, pinned, current };
}

// ─── Bootstrap from built-in presets ──────────────────────────

/**
 * Register the 6 built-in PRESETS as human-authored `active` skills (idempotent).
 * Existing entries are left untouched so operator/loop edits aren't clobbered.
 */
export function bootstrapFromPresets() {
  const reg = loadRegistry();
  let added = 0;
  for (const id of STRATEGY_IDS) {
    if (reg.skills[id]) continue;
    const skill = makeStrategySkill({
      id,
      version: 1,
      type: "composite",
      params: PRESETS[id],
      provenance: { author: "human", note: "bootstrapped from built-in preset" },
      status: "active",
      weight: id === "scalping" ? 1 : 0, // scalping is the default active strategy
    });
    reg.skills[id] = skill;
    pinSkillLock(skill);
    added++;
  }
  if (added > 0) {
    saveRegistry(reg);
    log("skills", `Bootstrapped ${added} preset(s) into the strategy-skill registry`);
  }
  return { added, total: Object.keys(reg.skills).length };
}

/** Test helper — wipe the registry (never call in runtime). */
export function _resetRegistryForTests() {
  try { if (fs.existsSync(REGISTRY_FILE)) fs.unlinkSync(REGISTRY_FILE); } catch {}
}
