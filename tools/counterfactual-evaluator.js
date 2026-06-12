/**
 * Counterfactual Evaluator — replay historical observations against candidate
 * rules to produce virtual A/B evidence without waiting for live trades.
 *
 * The structural problem this attacks: every learning loop needs dozens of
 * closed trades, but live throughput is ~7/day, so experiments starve for
 * weeks. Meanwhile the bot already records outcomes nobody mines:
 *   - observed-tokens.json   (status COMPLETED → initial→final mcap,
 *                             change_pct, performance label GEM/RUG/...)
 *   - shadow-watchlist.json  (skipped tokens → rugged/mooned/survived)
 *
 * Evidence-hierarchy honesty (operator rule: live > paper > backtest):
 *   - Counterfactual results go to DEDICATED experiments (name prefix "cf:",
 *     tag "counterfactual"), never into the live experiments they support —
 *     mixing would inflate live sample counts with backtest-grade evidence.
 *   - Both arms ARE recorded (replay can run baseline and candidate on the
 *     identical dataset — the one thing live candidate-only runs can't do).
 *   - Shadow outcomes use an explicit optimistic model (mooned = peak price,
 *     rugged = -90%, survived = 0%) and say so in the run notes.
 *   - Runs are delta-windowed on observation timestamps, the same cursor
 *     pattern as the evidence bridge, so reruns never double-count.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  createExperiment,
  getExperimentSummary,
  listExperiments,
  recordExperimentRun,
} from "../infra/agent-collab/experiment-tracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBSERVED_FILE = process.env.PONYOU_OBSERVED_TOKENS_FILE
  || path.join(__dirname, "../observed-tokens.json");
const SHADOW_FILE = process.env.PONYOU_SHADOW_WATCHLIST_FILE
  || path.join(__dirname, "../shadow-watchlist.json");

const SHADOW_RUG_RETURN_PCT = -90;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// ─── Dataset ──────────────────────────────────────────────────────────────────

/**
 * Normalize both sources into one observation contract:
 * { ts, mint, source, rug_score, mcap, narrative, return_pct, is_rug, label }
 * Only observations with a terminal outcome are included.
 */
export function loadObservations() {
  const out = [];

  const observed = readJson(OBSERVED_FILE)?.observed || {};
  for (const t of Object.values(observed)) {
    if (t.status !== "COMPLETED" || t.change_pct == null) continue;
    out.push({
      ts: t.check_at || t.observed_at,
      mint: t.mint,
      source: "observed",
      rug_score: Number(t.rug_score) || 0,
      mcap: Number(t.initial_mcap) || 0,
      narrative: (typeof t.narrative === "string" ? t.narrative : "OTHER").toUpperCase(),
      return_pct: Number(t.change_pct) || 0,
      is_rug: t.performance === "RUG",
      label: t.performance || "UNKNOWN",
      outcome_model: "observed-final-mcap",
    });
  }

  const shadow = readJson(SHADOW_FILE)?.tokens || {};
  for (const t of Object.values(shadow)) {
    const status = t.status;
    if (!["rugged", "mooned", "survived"].includes(status)) continue;
    let returnPct = 0;
    if (status === "rugged") returnPct = SHADOW_RUG_RETURN_PCT;
    else if (status === "mooned" && t.entry_price > 0 && t.peak_price > 0) {
      returnPct = ((t.peak_price / t.entry_price) - 1) * 100; // optimistic: peak
    }
    out.push({
      ts: new Date(t.added_at || Date.now()).toISOString(),
      mint: t.mint,
      source: "shadow",
      rug_score: Number(t.rug_score) || 0,
      mcap: Number(t.entry_liq) > 0 ? Number(t.entry_liq) : 0, // proxy — shadow lacks mcap
      narrative: "OTHER",
      return_pct: returnPct,
      is_rug: status === "rugged",
      label: status.toUpperCase(),
      outcome_model: "shadow-optimistic",
    });
  }

  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// ─── Gates (composable entry predicates) ──────────────────────────────────────

export const gates = {
  rugScoreMax: (max) => (o) => o.rug_score < max,
  mcapBand: (min, max) => (o) => o.mcap >= min && o.mcap <= max,
  narrativeIn: (allow) => (o) => allow.map((n) => n.toUpperCase()).includes(o.narrative),
  hasNarrative: () => (o) => !!o.narrative && o.narrative !== "OTHER",
  // Per-mcap-band rug thresholds: [{ maxMcap, maxRug }, ...] checked in order;
  // an observation falls into the first band whose maxMcap covers it.
  rugScoreByBand: (bands) => (o) => {
    const band = bands.find((b) => o.mcap <= b.maxMcap) || bands[bands.length - 1];
    return o.rug_score < band.maxRug;
  },
  all: (...fns) => (o) => fns.every((fn) => fn(o)),
};

// ─── Replay ───────────────────────────────────────────────────────────────────

export function replayGate(gate, observations) {
  const entered = [];
  const skipped = [];
  for (const o of observations) (gate(o) ? entered : skipped).push(o);

  const wins = entered.filter((o) => o.return_pct > 0 && !o.is_rug).length;
  const rugsEntered = entered.filter((o) => o.is_rug).length;
  const avgReturn = entered.length
    ? entered.reduce((s, o) => s + o.return_pct, 0) / entered.length
    : 0;

  return {
    sample: observations.length,
    entered: entered.length,
    wins,
    losses: entered.length - wins,
    win_rate: entered.length ? wins / entered.length : 0,
    rugs_entered: rugsEntered,
    rug_rate: entered.length ? rugsEntered / entered.length : 0,
    avg_return_pct: avgReturn,
    rugs_avoided: skipped.filter((o) => o.is_rug).length,
    winners_missed: skipped.filter((o) => o.return_pct > 0 && !o.is_rug).length,
  };
}

export function compareGates(baselineGate, candidateGate, observations) {
  const baseline = replayGate(baselineGate, observations);
  const candidate = replayGate(candidateGate, observations);
  return {
    observations: observations.length,
    baseline,
    candidate,
    delta: {
      win_rate: candidate.win_rate - baseline.win_rate,
      rug_rate: candidate.rug_rate - baseline.rug_rate,
      avg_return_pct: candidate.avg_return_pct - baseline.avg_return_pct,
      entered: candidate.entered - baseline.entered,
    },
  };
}

// ─── Scenario registry ────────────────────────────────────────────────────────
// Each scenario mirrors a live experiment's open question so its CF twin
// produces directly comparable evidence.

export const SCENARIOS = {
  "cf:rug-gate-35": {
    supports: "exp #10 (paper-throughput-and-entry-rug-gate)",
    hypothesis: "Entry rug gate 35 vs legacy 60 — replay outcomes of every observed/shadow token against both thresholds.",
    baseline_rule: "enter when rug_score < 60",
    candidate_rule: "enter when rug_score < 35",
    baseline: gates.rugScoreMax(60),
    candidate: gates.rugScoreMax(35),
  },
  "cf:mcap-diversified": {
    supports: "exp #13 (mcap-band diversified hunting)",
    hypothesis: "Mcap 3K-50M (diversified set) vs micro-only 3K-200K — which cohort carries better outcomes?",
    baseline_rule: "enter when 3K <= mcap <= 200K",
    candidate_rule: "enter when 3K <= mcap <= 50M",
    baseline: gates.mcapBand(3_000, 200_000),
    candidate: gates.mcapBand(3_000, 50_000_000),
  },
  // Counter-scenario to cf:mcap-diversified's negative verdict (n=110,
  // WR -5.8pp): is the problem the wide band itself, or one uniform rug gate
  // across bands with structurally different rug rates?
  "cf:rug-gate-per-band": {
    supports: "exp #13 (mcap-band diversified hunting) — pertanyaan lanjutan dari verdict negatif cf:mcap-diversified",
    hypothesis: "Gate rug per-band (micro <=200K dipersempit ke 25, di atasnya tetap 35) vs gate seragam 35 — apakah selektivitas ekstra di band micro memulihkan win-rate set terdiversifikasi?",
    baseline_rule: "enter when rug_score < 35 (uniform)",
    candidate_rule: "enter when rug_score < 25 if mcap <= 200K, else rug_score < 35",
    baseline: gates.rugScoreMax(35),
    candidate: gates.rugScoreByBand([
      { maxMcap: 200_000, maxRug: 25 },
      { maxMcap: Infinity, maxRug: 35 },
    ]),
  },
  "cf:rug-gate-25": {
    supports: "exp #10 (gate-35 sudah dikunci via cf:rug-gate-35) — uji apakah lebih ketat lagi masih menambah",
    hypothesis: "Gate 25 vs gate 35 — apakah memperketat melewati 35 menambah win-rate, atau mulai memakan winner (winners_missed)?",
    baseline_rule: "enter when rug_score < 35",
    candidate_rule: "enter when rug_score < 25",
    baseline: gates.rugScoreMax(35),
    candidate: gates.rugScoreMax(25),
  },
  "cf:narrative-heat": {
    supports: "exp #9 (narrative-heat-driven hunting)",
    hypothesis: "Dalam cohort yang sudah lolos gate 35, apakah token ber-narasi (non-OTHER) mengungguli cohort penuh? Catatan bias: observasi shadow selalu OTHER, jadi arm kandidat condong ke sumber observed.",
    baseline_rule: "enter when rug_score < 35",
    candidate_rule: "enter when rug_score < 35 AND narrative != OTHER",
    baseline: gates.rugScoreMax(35),
    candidate: gates.all(gates.rugScoreMax(35), gates.hasNarrative()),
  },
};

// ─── Recording (delta-windowed, dedicated CF experiments) ─────────────────────

function findOrCreateCfExperiment(name, scenario) {
  const existing = listExperiments({ limit: 100 }).find((e) => e.name === name);
  if (existing) return existing;
  return createExperiment({
    name,
    hypothesis: `${scenario.hypothesis} [COUNTERFACTUAL — bukti backtest-grade, mendukung ${scenario.supports}; keputusan tetap butuh validasi live]`,
    baseline_rule: scenario.baseline_rule,
    candidate_rule: scenario.candidate_rule,
    owner: "counterfactual-evaluator",
    status: "running",
    minimum_sample_size: 30,
    tags: ["counterfactual"],
  });
}

function recordArm(expId, variant, metrics, window, model) {
  return recordExperimentRun({
    experiment_id: expId,
    variant,
    sample_size: metrics.entered,
    wins: metrics.wins,
    losses: metrics.losses,
    pnl_pct: metrics.avg_return_pct,
    max_drawdown_pct: 0,
    rugs_avoided: metrics.rugs_avoided,
    notes:
      `counterfactual replay window ${window.from} → ${window.until} (${window.count} obs): ` +
      `entered=${metrics.entered} wr=${(metrics.win_rate * 100).toFixed(0)}% rug_rate=${(metrics.rug_rate * 100).toFixed(0)}% ` +
      `rugs_avoided=${metrics.rugs_avoided} winners_missed=${metrics.winners_missed}. ` +
      `Models: ${model}. Backtest-grade evidence — bukan pengganti validasi live.`,
    context: { counterfactual: true, window_from: window.from, window_until: window.until },
  });
}

export function runCounterfactualScenarios({ scenarios = Object.keys(SCENARIOS) } = {}) {
  const all = loadObservations();
  const models = [...new Set(all.map((o) => o.outcome_model))].join("+") || "none";
  const results = [];

  for (const key of scenarios) {
    const scenario = SCENARIOS[key];
    if (!scenario) { results.push({ scenario: key, error: "unknown scenario" }); continue; }

    const exp = findOrCreateCfExperiment(key, scenario);
    if (exp.error) { results.push({ scenario: key, error: exp.error }); continue; }

    const { runs } = getExperimentSummary({ id: exp.id });
    const cfRuns = runs.filter((r) => r.context?.counterfactual);
    const cursor = cfRuns.length ? cfRuns[cfRuns.length - 1].context.window_until : null;
    const windowObs = cursor ? all.filter((o) => String(o.ts) > String(cursor)) : all;

    const fullComparison = compareGates(scenario.baseline, scenario.candidate, all);
    if (windowObs.length === 0) {
      results.push({ scenario: key, experiment_id: exp.id, recorded: false, reason: "no_new_observations", full_comparison: fullComparison });
      continue;
    }

    const window = {
      from: cursor || windowObs[0].ts,
      until: windowObs[windowObs.length - 1].ts,
      count: windowObs.length,
    };
    const baselineMetrics = replayGate(scenario.baseline, windowObs);
    const candidateMetrics = replayGate(scenario.candidate, windowObs);
    recordArm(exp.id, "baseline", baselineMetrics, window, models);
    recordArm(exp.id, "candidate", candidateMetrics, window, models);

    results.push({
      scenario: key,
      experiment_id: exp.id,
      supports: scenario.supports,
      recorded: true,
      window,
      window_baseline: baselineMetrics,
      window_candidate: candidateMetrics,
      full_comparison: fullComparison,
      recommendation: getExperimentSummary({ id: exp.id }).summary.recommendation,
    });
  }

  return { observations_total: all.length, outcome_models: models, results };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const only = process.argv.indexOf("--scenario");
  const scenarios = only !== -1 ? [process.argv[only + 1]] : undefined;
  console.log(JSON.stringify(runCounterfactualScenarios(scenarios ? { scenarios } : {}), null, 2));
}
