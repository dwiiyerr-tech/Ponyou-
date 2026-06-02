#!/usr/bin/env node
/**
 * Experiment #1 offline A/B — GMGN row-risk (Layer 2d) rejection precision.
 *
 * READ-ONLY. Fetches live GMGN trending tokens (no trades, no state writes) and
 * scores each one TWICE through scoreRugRisk:
 *   baseline  — rug_signals WITHOUT gmgn_row_risk (pre-Layer2d behavior)
 *   candidate — rug_signals WITH    gmgn_row_risk (Layer 2d active)
 *
 * The experiment hypothesis is about rejection PRECISION at screening time, which
 * is observable from the rug score itself — it does NOT require waiting for tokens
 * to actually rug. So this gives a legitimate candidate sample from real live data
 * without restarting the live bot or fabricating outcomes.
 *
 * Both variants pass _helius_expected:false so the fail-safe telemetry guards
 * don't fire — this isolates Layer 2d's MARGINAL effect on the score.
 *
 * Usage: node scripts/experiment-gmgn-row-risk.js
 */
import { config } from "../config.js";
import { isGmgnEnabled, getTrendingTokens } from "../tools/gmgn.js";
import { scoreRugRisk } from "../lessons.js";

function scoreVariant(token, withRowRisk) {
  return scoreRugRisk({
    mint: token.address,
    creator: null,
    launchpad: token.launchpad,
    mcap: token.marketcap || 0,
    rug_signals: {
      _helius_expected: false,
      _helius_degraded: false,
      gmgn_row_risk: withRowRisk ? (token._gmgn_risk || null) : null,
    },
  });
}

function hasAnyRowRisk(r) {
  if (!r) return false;
  return Object.values(r).some(v => v != null);
}

async function main() {
  if (!isGmgnEnabled()) {
    console.error("GMGN not enabled (GMGN_API_KEY unset). Cannot run experiment.");
    process.exit(2);
  }

  // Pull two windows to widen the sample; dedupe by mint.
  const [r1h, r5m] = await Promise.all([
    getTrendingTokens("1h", 50, "sol").catch(() => null),
    getTrendingTokens("5m", 30, "sol").catch(() => null),
  ]);
  const rows = [...(Array.isArray(r1h) ? r1h : []), ...(Array.isArray(r5m) ? r5m : [])];
  if (rows.length === 0) {
    console.error("No trending rows returned from GMGN (network/auth?). Aborting.");
    process.exit(3);
  }

  const seen = new Set();
  const tokens = [];
  for (const t of rows) {
    if (!t.address || seen.has(t.address)) continue;
    seen.add(t.address);
    tokens.push(t);
  }

  // Only tokens that actually carry row-risk data exercise Layer 2d.
  const withData = tokens.filter(t => hasAnyRowRisk(t._gmgn_risk));

  let candidateBlocked = 0;   // candidate score >= 60
  let baselineBlocked = 0;    // baseline score >= 60
  let newlyBlocked = 0;       // candidate >=60 but baseline <60 (precision gain)
  let candidateFlagged = 0;   // candidate score >= 25 (ambiguous+)
  let honeypotHits = 0;
  let highRugRatio = 0;       // rug_ratio >= 0.5
  let scoreDeltaSum = 0;
  const samples = [];

  for (const t of withData) {
    const base = scoreVariant(t, false);
    const cand = scoreVariant(t, true);
    const delta = cand.score - base.score;
    scoreDeltaSum += delta;
    if (cand.score >= 60) candidateBlocked++;
    if (base.score >= 60) baselineBlocked++;
    if (cand.score >= 60 && base.score < 60) newlyBlocked++;
    if (cand.score >= 25) candidateFlagged++;
    if (t._gmgn_risk.is_honeypot === true) honeypotHits++;
    if (t._gmgn_risk.rug_ratio != null && t._gmgn_risk.rug_ratio >= 0.5) highRugRatio++;
    if (delta > 0) {
      samples.push({
        sym: t.symbol, mint: t.address.slice(0, 10),
        base: base.score, cand: cand.score, delta,
        rug_ratio: t._gmgn_risk.rug_ratio, honeypot: t._gmgn_risk.is_honeypot,
      });
    }
  }

  const n = withData.length;
  const result = {
    fetched_total: tokens.length,
    with_row_risk_data: n,
    baseline_blocked: baselineBlocked,
    candidate_blocked: candidateBlocked,
    newly_blocked: newlyBlocked,
    candidate_flagged: candidateFlagged,
    honeypot_hits: honeypotHits,
    high_rug_ratio_hits: highRugRatio,
    avg_score_delta: n ? Number((scoreDeltaSum / n).toFixed(2)) : 0,
    baseline_block_rate: n ? Number((baselineBlocked / n).toFixed(3)) : 0,
    candidate_block_rate: n ? Number((candidateBlocked / n).toFixed(3)) : 0,
  };

  console.log("\n=== Experiment #1: GMGN row-risk A/B (live trending, read-only) ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("\nTop score-increasing tokens (candidate vs baseline):");
  samples.sort((a, b) => b.delta - a.delta).slice(0, 15)
    .forEach(s => console.log(`  ${s.sym.padEnd(12)} base=${s.base} cand=${s.cand} (+${s.delta}) rug_ratio=${s.rug_ratio ?? "?"} hp=${s.honeypot ?? "?"}`));
  console.log("\nMACHINE_RESULT=" + JSON.stringify(result));
}

main().catch(e => { console.error("experiment error:", e.message); process.exit(1); });
