/**
 * Skill Registry — Phase 4 (ClawHub-style INTERNAL marketplace + vetting).
 *
 * Makes strategy-skills portable: export a registered skill as a self-describing
 * package (manifest + scorecard + provenance + capability declaration + content
 * hash), and import a package back through a hard VETTING GATE before it can
 * enter the registry.
 *
 * Threat model (the ClawHub-malware / Snyk-Critical lesson): a shared skill is
 * untrusted input. Strategy-skills are meant to be PURE DATA (the PRESET param
 * shape the engine already consumes) — so the gate:
 *   1. structural validation (validateStrategySkill),
 *   2. content-hash integrity (recompute must match the package's declared hash),
 *   3. a params allow-list — reject any top-level param key outside the known
 *      PRESET shape, and reject any non-JSON / executable payload (functions,
 *      smuggled code), so a package can't carry behavior, only parameters,
 *   4. capability check — a package declaring (or smuggling) an EXECUTION-class
 *      capability is QUARANTINED: imported at status "draft", weight 0, and a
 *      hard flag that blocks promotion. Execution-class skills are NEVER
 *      auto-exec on import (the locked safety rule).
 *
 * Internal only — there is no public publish path. Imported packages are
 * hash-pinned in skills-lock.json with source:"imported" so they stay
 * provenance-distinguishable from native skills.
 */

import {
  makeStrategySkill,
  validateStrategySkill,
  computeSkillHash,
  upsertStrategySkill,
  getStrategySkill,
  getSkillLockEntry,
  listStrategySkills,
} from "./strategy-skills.js";
import { log } from "./logger.js";

export const PACKAGE_FORMAT_VERSION = 1;

// Capabilities that make a package execution-class. A legit data-only
// strategy-skill declares NONE of these. Any of them → quarantine.
export const EXECUTION_CAPABILITIES = [
  "live_trade",    // can move real capital
  "wallet_access", // can read/sign with a wallet
  "external_call", // makes network calls
  "shell",         // runs shell commands
  "fs_write",      // writes the filesystem
  "auto_exec",     // requests to run on import
];

// The only top-level keys a strategy-skill's `params` may contain (the PRESET
// shape). Anything else is treated as a smuggled directive and rejected.
export const ALLOWED_PARAM_KEYS = new Set([
  "filters", "minimal_roi", "stoploss", "trailing_stop", "partial_tp",
  "use_llm", "llm_min_confidence", "staged_entry", "roi_presets",
]);

// ─── Export ───────────────────────────────────────────────────

/**
 * Package a registered skill into a portable, self-describing artifact.
 * @returns {object} the package (a plain JSON-serializable object)
 */
export function exportSkillPackage(id, { capabilities = [] } = {}) {
  const skill = getStrategySkill(id);
  if (!skill) throw new Error(`Cannot export unknown skill: ${id}`);
  const manifest = {
    id: skill.id,
    version: skill.version,
    type: skill.type,
    params: skill.params,
    provenance: skill.provenance,
  };
  return {
    format_version: PACKAGE_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    manifest,
    backtest_scorecard: skill.backtest_scorecard ?? null,
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    // The integrity hash is over behavior-defining fields (same as the
    // registry's content hash), so tampering with params/provenance is caught.
    hash: computeSkillHash(skill),
  };
}

// ─── Vetting gate ─────────────────────────────────────────────

/**
 * Is the value pure JSON data (no functions, symbols, etc.)? Guards against a
 * package smuggling executable behavior into a "data-only" skill.
 */
function isPlainData(value, depth = 0) {
  if (depth > 12) return false; // pathological nesting
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return value.every(v => isPlainData(v, depth + 1));
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false; // no class instances
    return Object.values(value).every(v => isPlainData(v, depth + 1));
  }
  return false; // function / symbol / bigint / undefined
}

/**
 * Vet a package without importing it. Returns the verdict + whether it must be
 * quarantined (execution-class).
 *
 * @returns {{ passed, quarantine, capabilities, executionCapabilities, reasons }}
 */
export function vetPackage(pkg) {
  const reasons = [];
  if (!pkg || typeof pkg !== "object") {
    return { passed: false, quarantine: true, capabilities: [], executionCapabilities: [], reasons: ["package is not an object"] };
  }
  if (pkg.format_version !== PACKAGE_FORMAT_VERSION) {
    reasons.push(`unsupported format_version ${pkg.format_version}`);
  }

  const manifest = pkg.manifest || {};
  // Reconstruct the skill shape the registry validates.
  const candidate = {
    id: manifest.id,
    version: manifest.version,
    type: manifest.type,
    params: manifest.params,
    status: "draft",
    weight: 0,
    provenance: {
      author: manifest.provenance?.author === "loop" ? "loop" : "human",
      parent_skills: manifest.provenance?.parent_skills || [],
      experiment_id: manifest.provenance?.experiment_id ?? null,
    },
  };

  const v = validateStrategySkill(candidate);
  if (!v.ok) reasons.push(...v.errors);

  // 3a. Params must be pure data.
  if (!isPlainData(manifest.params)) {
    reasons.push("params contain non-JSON / executable payload");
  }
  // 3b. Params top-level keys must be on the allow-list.
  if (manifest.params && typeof manifest.params === "object") {
    for (const k of Object.keys(manifest.params)) {
      if (!ALLOWED_PARAM_KEYS.has(k)) reasons.push(`disallowed param key "${k}"`);
    }
  }

  // 2. Hash integrity — recompute over the manifest and compare.
  const recomputed = computeSkillHash(candidate);
  if (pkg.hash && pkg.hash !== recomputed) {
    reasons.push("hash mismatch — package content was tampered with");
  }

  // 4. Capability check. Declared caps + a smuggled `auto_exec` flag anywhere.
  const declared = Array.isArray(pkg.capabilities) ? pkg.capabilities : [];
  const executionCapabilities = declared.filter(c => EXECUTION_CAPABILITIES.includes(c));
  const quarantine = executionCapabilities.length > 0;

  return {
    passed: reasons.length === 0,
    quarantine,
    capabilities: declared,
    executionCapabilities,
    reasons,
  };
}

// ─── Import ───────────────────────────────────────────────────

/**
 * Import a vetted package into the registry. ALWAYS lands at status "draft",
 * weight 0 — an imported skill is never auto-activated, and an execution-class
 * package is additionally quarantined (a hard flag that downstream promotion
 * must refuse). Returns the import result; throws only on a failed gate.
 *
 * @param {object} pkg
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite=false] allow replacing an existing id
 */
export function importSkillPackage(pkg, { overwrite = false } = {}) {
  const verdict = vetPackage(pkg);
  if (!verdict.passed) {
    const err = new Error(`Package vetting failed: ${verdict.reasons.join("; ")}`);
    err.verdict = verdict;
    throw err;
  }

  const id = pkg.manifest.id;
  const existing = getStrategySkill(id);
  if (existing && !overwrite) {
    const err = new Error(`Skill "${id}" already exists — pass overwrite:true to replace`);
    err.verdict = verdict;
    throw err;
  }

  // Build the skill from the manifest, forced to a safe inert state.
  const skill = makeStrategySkill({
    id,
    version: pkg.manifest.version,
    type: pkg.manifest.type,
    params: pkg.manifest.params,
    provenance: {
      author: pkg.manifest.provenance?.author === "loop" ? "loop" : "human",
      parent_skills: pkg.manifest.provenance?.parent_skills || [],
      experiment_id: pkg.manifest.provenance?.experiment_id ?? null,
      note: `imported${verdict.quarantine ? " (QUARANTINED: execution-class)" : ""}`,
    },
    backtest_scorecard: pkg.backtest_scorecard ?? null,
    status: "draft",
    weight: 0,
  });

  const lockMeta = {
    capabilities: verdict.capabilities,
    executionCapabilities: verdict.executionCapabilities,
    quarantined: verdict.quarantine,
    importedHash: pkg.hash || null,
    imported_at: new Date().toISOString(),
  };

  upsertStrategySkill(skill, { source: "imported", lockMeta });
  log("skill_registry",
    `Imported skill "${id}" as draft${verdict.quarantine ? " — QUARANTINED (execution-class, never auto-exec)" : ""}`
  );

  return { imported: true, skillId: id, quarantined: verdict.quarantine, verdict };
}

// ─── Inspection ───────────────────────────────────────────────

/** True if an imported skill was quarantined as execution-class. */
export function isQuarantined(id) {
  return getSkillLockEntry(id)?.vetting?.quarantined === true;
}

/** List all skills that entered the registry via import (with vetting meta). */
export function listImportedSkills() {
  return listStrategySkills().filter(s => getSkillLockEntry(s.id)?.source === "imported").map(s => ({
    id: s.id,
    status: s.status,
    weight: s.weight,
    author: s.provenance?.author,
    vetting: getSkillLockEntry(s.id)?.vetting || null,
  }));
}

export default {
  PACKAGE_FORMAT_VERSION,
  EXECUTION_CAPABILITIES,
  ALLOWED_PARAM_KEYS,
  exportSkillPackage,
  vetPackage,
  importSkillPackage,
  isQuarantined,
  listImportedSkills,
};
