/**
 * Feature Registry v2.0 — declarative signals + circuit breaker + health stats.
 *
 * Per-feature:
 *   - Circuit breaker: auto-disable after 3 consecutive errors in a cycle
 *   - Runtime toggle:  enableFeature(name) / disableFeature(name)
 *   - Health stats:    latency p50, error count, breaker trips, last score
 *
 * Usage:
 *   registerFeature({ name: "my_signal", weight: 0.15, score: (ctx) => {...} });
 *   runAllFeatures(ctx) → { aggregate, scores, gates, health }
 *   getHealthReport()  → per-feature status for dashboard
 */

const _features = [];
const _featureMap = new Map();

// ─── Health & Circuit Breaker State ──────────────────────────────

const _health = new Map(); // name → { calls, errors, latencyMs[], breakerTrips, tripped, lastScore }

function healthOf(name) {
  if (!_health.has(name)) {
    _health.set(name, {
      calls: 0,
      errors: 0,
      latencyMs: [],
      breaker_trips: 0,
      breaker_tripped: false,
      breaker_tripped_at: null,
      last_score: 0,
      enabled: true,
    });
  }
  return _health.get(name);
}

const BREAKER_MAX_CONSECUTIVE_ERRORS = 3;
const LATENCY_WINDOW = 50; // keep last N latency samples

// ─── Registration + Toggle ───────────────────────────────────────

export function registerFeature({ name, weight = 0.1, score, gate = null, note = "" }) {
  if (_featureMap.has(name)) {
    const existing = _featureMap.get(name);
    existing.weight = weight;
    existing.score = score;
    existing.gate = gate;
    existing.note = note || existing.note;
    return;
  }
  _features.push({ name, weight, score, gate, note });
  _featureMap.set(name, _features[_features.length - 1]);
  healthOf(name); // init health
}

export function unregisterFeature(name) {
  const idx = _features.findIndex(f => f.name === name);
  if (idx >= 0) _features.splice(idx, 1);
  _featureMap.delete(name);
  _health.delete(name);
}

export function enableFeature(name) {
  const h = healthOf(name);
  h.enabled = true;
  h.breaker_tripped = false;
  h.breaker_tripped_at = null;
  return true;
}

export function disableFeature(name) {
  const h = healthOf(name);
  h.enabled = false;
  return true;
}

export function isFeatureEnabled(name) {
  return healthOf(name).enabled && !healthOf(name).breaker_tripped;
}

export function listFeatures() {
  return _features.map(f => {
    const h = healthOf(nameOf(f));
    return {
      name: f.name,
      weight: f.weight,
      has_gate: typeof f.gate === "function",
      note: f.note,
      enabled: h.enabled && !h.breaker_tripped,
      breaker_tripped: h.breaker_tripped,
    };
  });
}

const nameOf = (f) => f.name || f;

// ─── Core Runner ─────────────────────────────────────────────────

export function runAllFeatures(ctx = {}) {
  const scores = {};
  const gates = {};
  const healthSnapshot = {};
  let totalWeight = 0;
  let weightedSum = 0;
  let allGatesPassed = true;
  let consecutiveErrors = 0;

  for (const f of _features) {
    const h = healthOf(f.name);

    // Skip disabled or breaker-tripped features
    if (!h.enabled) {
      gates[f.name] = "disabled";
      continue;
    }
    if (h.breaker_tripped) {
      gates[f.name] = "breaker_tripped";
      continue;
    }

    // Gate check
    if (f.gate && !f.gate(ctx)) {
      gates[f.name] = false;
      continue;
    }
    gates[f.name] = true;

    // Score with timing + error tracking
    const t0 = Date.now();
    let s = 0;
    let errored = false;
    try {
      s = clamp(Number(f.score(ctx)) || 0, 0, 100);
      if (!Number.isFinite(s)) { s = 0; errored = true; }
    } catch (e) {
      s = 0;
      errored = true;
    }
    const latency = Date.now() - t0;

    // Update health
    h.calls++;
    h.last_score = s;
    h.latencyMs.push(latency);
    if (h.latencyMs.length > LATENCY_WINDOW) h.latencyMs.shift();

    if (errored) {
      h.errors++;
      consecutiveErrors++;
      // Circuit breaker: trip after N consecutive errors
      if (consecutiveErrors >= BREAKER_MAX_CONSECUTIVE_ERRORS && !h.breaker_tripped) {
        h.breaker_tripped = true;
        h.breaker_tripped_at = new Date().toISOString();
        h.breaker_trips++;
        gates[f.name] = "breaker_tripped";
        continue;
      }
    } else {
      consecutiveErrors = 0;
    }

    scores[f.name] = s;
    weightedSum += s * f.weight;
    totalWeight += f.weight;

    if (f.weight >= 0.20 && s < 15) allGatesPassed = false;

    healthSnapshot[f.name] = {
      score: s,
      latency_ms: latency,
      errored,
    };
  }

  const aggregate = totalWeight > 0
    ? Math.round(weightedSum / totalWeight)
    : 0;

  return {
    scores,
    gates,
    aggregate,
    passed: allGatesPassed,
    total_weight: Number(totalWeight.toFixed(2)),
    health: healthSnapshot,
  };
}

// ─── Health Report ───────────────────────────────────────────────

export function getHealthReport() {
  const report = [];
  for (const f of _features) {
    const h = healthOf(f.name);
    const lats = h.latencyMs.slice(-LATENCY_WINDOW).sort((a, b) => a - b);
    const p50 = lats.length > 0 ? lats[Math.floor(lats.length / 2)] : 0;
    const p95 = lats.length > 0 ? lats[Math.floor(lats.length * 0.95)] : 0;
    const errorRate = h.calls > 0 ? (h.errors / h.calls * 100).toFixed(1) : "0.0";

    report.push({
      feature: f.name,
      weight: f.weight,
      enabled: h.enabled && !h.breaker_tripped,
      breaker_tripped: h.breaker_tripped,
      breaker_trips: h.breaker_trips,
      calls: h.calls,
      errors: h.errors,
      error_rate_pct: Number(errorRate),
      latency_p50_ms: p50,
      latency_p95_ms: p95,
      last_score: h.last_score,
    });
  }
  return report;
}

export function getHealthSummary() {
  const report = getHealthReport();
  const total = report.length;
  const healthy = report.filter(r => r.enabled && !r.breaker_tripped).length;
  const tripped = report.filter(r => r.breaker_tripped).length;
  const disabled = report.filter(r => !r.enabled).length;

  return {
    total_features: total,
    healthy,
    tripped,
    disabled,
    features: report,
  };
}

/**
 * Auto-reset breakers older than `maxAgeMs`. Call once per cycle.
 */
export function autoResetBreakers({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  const now = Date.now();
  for (const [name, h] of _health) {
    if (h.breaker_tripped && h.breaker_tripped_at) {
      const age = now - new Date(h.breaker_tripped_at).getTime();
      if (age > maxAgeMs) {
        h.breaker_tripped = false;
        h.breaker_tripped_at = null;
      }
    }
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

// ─── Default Registrations ───────────────────────────────────────

export function registerDefaultFeatures() {
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

export const FEATURE_REGISTRY_VERSION = "2.0.0";
