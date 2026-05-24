/**
 * Signal Aggregator — combines independent scoring modules into a unified
 * 0-100 signal strength score. Used by the decision workflow and LLM prompt
 * to give a single-number edge assessment per candidate.
 *
 * Weights are tuned to prioritize conviction (history) while giving meaningful
 * weight to real-time velocity (momentum).
 */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * @param {Object} opts
 * @param {Object} opts.conviction       - from getCoinConviction()
 * @param {Object} opts.velocity         - per-narrative velocity from detectNarrativeVelocity()
 * @param {Object} opts.crossBatch       - from getCrossBatchVelocity()
 * @param {Object} opts.regime           - from getRegimeAssessment()
 * @param {Object} opts.kelly            - capital-aware sizing result
 * @param {Object} opts.technicals       - technical indicators result
 * @param {string} opts.marketCondition  - HOT/NORMAL/COLD/DEAD
 * @returns {{ signal_score: number, components: Object, summary: string }}
 */
export function aggregateSignal({
  conviction = {},
  velocity = null,
  crossBatch = null,
  regime = {},
  kelly = {},
  technicals = {},
  marketCondition = "UNKNOWN",
  narrativeTags = [],
} = {}) {
  const components = {};

  // 1. Conviction (weight: 0.35) — strongest because it carries trade history
  const convScore = Number(conviction.conviction_score || 0);
  const convConf = Number(conviction.confidence_score || 0);
  components.conviction = clamp(convScore * 0.6 + convConf * 0.4, 0, 100);

  // 2. Narrative velocity (weight: 0.25) — real-time momentum signal
  let velScore = 0;
  if (velocity && narrativeTags.length > 0) {
    for (const tag of narrativeTags) {
      const name = typeof tag === "string" ? tag : tag?.narrative;
      if (!name) continue;
      const vel = velocity.velocities?.[name] || velocity[name];
      if (vel && vel.velocity_score > velScore) {
        velScore = vel.velocity_score;
      }
    }
  }
  components.velocity = clamp(velScore, 0, 100);

  // 3. Cross-batch sustained boost (weight: 0.10)
  let sustainedScore = 0;
  if (crossBatch?.active && narrativeTags.length > 0) {
    for (const tag of narrativeTags) {
      const name = typeof tag === "string" ? tag : tag?.narrative;
      if (!name) continue;
      const cb = crossBatch.active.find(a => a.narrative === name);
      if (cb && cb.cross_batch_score > sustainedScore) {
        sustainedScore = cb.cross_batch_score;
        if (cb.is_sustained) sustainedScore = Math.min(100, sustainedScore + 15);
      }
    }
  }
  components.cross_batch = clamp(sustainedScore, 0, 100);

  // 4. Trending + sustained boost from conviction (weight: 0.15)
  const trendingBoost = Number(conviction.trending_boost || 0);
  const sustainedBoost = Number(conviction.sustained_boost || 0);
  components.narrative_boost = clamp(trendingBoost * 2.5 + sustainedBoost * 4, 0, 100);

  // 5. Kelly edge (weight: 0.10)
  let kellyScore = 50;
  if (kelly.should_skip) kellyScore = 0;
  else if (kelly.effective_fraction != null) {
    kellyScore = clamp(50 + Number(kelly.effective_fraction) * 120, 0, 100);
  }
  components.kelly = kellyScore;

  // 6. Technical + regime (weight: 0.05)
  let techScore = 50;
  if (technicals.momentum_score != null) {
    techScore = clamp(50 + Number(technicals.momentum_score) * 0.5, 0, 100);
  }
  if (marketCondition === "HOT") techScore = clamp(techScore + 10, 0, 100);
  if (marketCondition === "DEAD") techScore = clamp(techScore - 25, 0, 100);
  if (regime.stance === "strong") techScore = clamp(techScore + 12, 0, 100);
  if (regime.stance === "avoid") techScore = clamp(techScore - 20, 0, 100);
  components.technicals_regime = techScore;

  // ─── Weighted composite ────────────────────────────────────────
  const signalScore = clamp(
    components.conviction * 0.35 +
    components.velocity * 0.25 +
    components.cross_batch * 0.10 +
    components.narrative_boost * 0.15 +
    components.kelly * 0.10 +
    components.technicals_regime * 0.05,
    0,
    100
  );

  let summary;
  if (signalScore >= 75) summary = "strong_buy";
  else if (signalScore >= 55) summary = "buy";
  else if (signalScore >= 40) summary = "probe";
  else if (signalScore >= 25) summary = "shadow";
  else summary = "skip";

  return {
    signal_score: signalScore,
    summary,
    components,
    weights: {
      conviction: 0.35,
      velocity: 0.25,
      cross_batch: 0.10,
      narrative_boost: 0.15,
      kelly: 0.10,
      technicals_regime: 0.05,
    },
  };
}
