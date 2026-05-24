/**
 * Feature Registry — declarative signal registration for the screening pipeline.
 *
 * Instead of manual import + splice into runScreeningCycle(), features register
 * themselves with a name, weight, scoring function, and optional gate function.
 * The pipeline calls runAllFeatures() to get a unified score map per candidate.
 *
 * Usage:
 *   import { registerFeature } from "./feature-registry.js";
 *   registerFeature({
 *     name: "conviction",
 *     weight: 0.35,
 *     score: ({ conviction }) => conviction.conviction_score || 0,
 *     gate:  ({ conviction }) => conviction.stance !== "avoid",
 *   });
 */

const _features = [];
const _featureMap = new Map();

/**
 * Register a feature signal.
 *
 * @param {Object} opts
 * @param {string} opts.name       - unique feature name
 * @param {number} opts.weight     - weight in aggregate score (0-1, sum should ≈ 1)
 * @param {Function} opts.score    - (candidateContext) => 0-100 score
 * @param {Function} [opts.gate]   - (candidateContext) => boolean, skip if false
 * @param {string} [opts.note]     - human-readable description
 */
export function registerFeature({ name, weight = 0.1, score, gate = null, note = "" }) {
  if (_featureMap.has(name)) {
    // Update existing
    const existing = _featureMap.get(name);
    existing.weight = weight;
    existing.score = score;
    existing.gate = gate;
    existing.note = note || existing.note;
    return;
  }
  const feature = { name, weight, score, gate, note };
  _features.push(feature);
  _featureMap.set(name, feature);
}

/**
 * Remove a feature by name. Returns true if it existed.
 */
export function unregisterFeature(name) {
  const idx = _features.findIndex(f => f.name === name);
  if (idx >= 0) _features.splice(idx, 1);
  return _featureMap.delete(name);
}

/**
 * List all registered features (name, weight, hasGate).
 */
export function listFeatures() {
  return _features.map(f => ({
    name: f.name,
    weight: f.weight,
    has_gate: typeof f.gate === "function",
    note: f.note,
  }));
}

/**
 * Run all registered features for a single candidate. Returns:
 *   { scores: { [featureName]: 0-100 }, gates: { [featureName]: boolean },
 *     aggregate: 0-100, passed: boolean }
 *
 * @param {Object} ctx — candidate context (must contain all data features need)
 */
export function runAllFeatures(ctx = {}) {
  const scores = {};
  const gates = {};
  let totalWeight = 0;
  let weightedSum = 0;
  let allGatesPassed = true;

  for (const f of _features) {
    // Gate check (skip if feature says this candidate doesn't apply)
    if (f.gate && !f.gate(ctx)) {
      gates[f.name] = false;
      continue;
    }
    gates[f.name] = true;

    let s = 0;
    try {
      s = clamp(Number(f.score(ctx)) || 0, 0, 100);
    } catch (e) {
      s = 0;
    }
    scores[f.name] = s;
    weightedSum += s * f.weight;
    totalWeight += f.weight;

    // Gate by minimum score if feature weight is high
    if (f.weight >= 0.20 && s < 15) allGatesPassed = false;
  }

  // Normalize if total weight ≠ 1
  const aggregate = totalWeight > 0
    ? Math.round(weightedSum / totalWeight)
    : 0;

  return {
    scores,
    gates,
    aggregate,
    passed: allGatesPassed,
    total_weight: Number(totalWeight.toFixed(2)),
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

// ─── Default Feature Registrations ────────────────────────────────
// Called once at startup to wire the standard signal set.

export function registerDefaultFeatures() {
  // Clear any previous registrations
  _features.length = 0;
  _featureMap.clear();

  registerFeature({
    name: "conviction",
    weight: 0.30,
    note: "Coin + narrative conviction from repeated observation",
    score: (ctx) => {
      const c = ctx.conviction || {};
      return clamp(Number(c.conviction_score || 0) * 0.6 + Number(c.confidence_score || 0) * 0.4, 0, 100);
    },
    gate: (ctx) => (ctx.conviction?.stance || "unknown") !== "avoid",
  });

  registerFeature({
    name: "narrative_velocity",
    weight: 0.20,
    note: "Real-time narrative momentum in current screening batch",
    score: (ctx) => {
      const vel = ctx.velocity;
      const tags = ctx.narrativeTags || [];
      let best = 0;
      for (const t of tags) {
        const name = typeof t === "string" ? t : t?.narrative;
        if (!name) continue;
        const v = vel?.velocities?.[name] || vel?.[name];
        if (v?.velocity_score > best) best = v.velocity_score;
      }
      return clamp(best, 0, 100);
    },
  });

  registerFeature({
    name: "cross_batch_velocity",
    weight: 0.12,
    note: "Sustained narrative momentum across multiple cycles",
    score: (ctx) => {
      const cb = ctx.crossBatch;
      const tags = ctx.narrativeTags || [];
      let best = 0;
      for (const t of tags) {
        const name = typeof t === "string" ? t : t?.narrative;
        if (!name) continue;
        const match = cb?.active?.find?.(a => a.narrative === name);
        if (match) {
          let s = match.cross_batch_score || 0;
          if (match.is_sustained) s = Math.min(100, s + 15);
          if (s > best) best = s;
        }
      }
      return clamp(best, 0, 100);
    },
  });

  registerFeature({
    name: "kelly_edge",
    weight: 0.15,
    note: "Kelly criterion position sizing edge signal",
    score: (ctx) => {
      const k = ctx.kelly || {};
      if (k.should_skip) return 0;
      const frac = Number(k.effective_fraction || k.kelly_fraction || 0);
      return clamp(50 + frac * 120, 0, 100);
    },
    gate: (ctx) => !(ctx.kelly?.should_skip),
  });

  registerFeature({
    name: "technicals",
    weight: 0.10,
    note: "Technical indicators + regime assessment",
    score: (ctx) => {
      let s = 50;
      const tech = ctx.technicals || {};
      if (tech.momentum_score != null) s += Number(tech.momentum_score) * 0.5;
      if (ctx.marketCondition === "HOT") s += 10;
      if (ctx.marketCondition === "DEAD") s -= 25;
      const regime = ctx.regime || {};
      if (regime.stance === "strong") s += 12;
      if (regime.stance === "avoid") s -= 20;
      return clamp(s, 0, 100);
    },
  });

  registerFeature({
    name: "rug_risk",
    weight: 0.08,
    note: "Inverse rug risk — 100 means zero risk",
    score: (ctx) => {
      const rs = Number(ctx.token?.rug_score || 0);
      return clamp(100 - rs, 0, 100);
    },
    gate: (ctx) => (ctx.token?.rug_score || 0) < 60,
  });

  registerFeature({
    name: "workflow_verdict",
    weight: 0.05,
    note: "Decision workflow verdict (active/probe/shadow/skip)",
    score: (ctx) => {
      const wf = ctx.workflow || {};
      if (wf.verdict === "active") return 100;
      if (wf.verdict === "probe") return 60;
      if (wf.verdict === "shadow") return 25;
      return 0;
    },
  });
}

export const FEATURE_REGISTRY_VERSION = "1.0.0";
