import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENTS_FILE = path.join(__dirname, "experiments.json");
const RUNS_FILE = path.join(__dirname, "experiment-runs.jsonl");

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function loadExperiments() {
  if (!fs.existsSync(EXPERIMENTS_FILE)) {
    return { experiments: [], next_id: 1 };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(EXPERIMENTS_FILE, "utf8"));
    const experiments = Array.isArray(parsed?.experiments) ? parsed.experiments : [];
    const nextId = Number.isFinite(parsed?.next_id) ? parsed.next_id : (
      experiments.reduce((max, item) => Math.max(max, item.id || 0), 0) + 1
    );
    return { experiments, next_id: nextId };
  } catch {
    return { experiments: [], next_id: 1 };
  }
}

function saveExperiments(data) {
  fs.writeFileSync(EXPERIMENTS_FILE, JSON.stringify(data, null, 2));
}

function loadRuns() {
  if (!fs.existsSync(RUNS_FILE)) return [];
  const raw = fs.readFileSync(RUNS_FILE, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendRun(run) {
  fs.appendFileSync(RUNS_FILE, `${JSON.stringify(run)}\n`, "utf8");
}

function normalizeTags(tags) {
  return Array.isArray(tags) ? tags.filter(Boolean).map(String) : [];
}

function computeRunDerivedMetrics(metrics = {}) {
  const sampleSize = Math.max(0, safeNumber(metrics.sample_size));
  const wins = Math.max(0, safeNumber(metrics.wins));
  const losses = Math.max(0, safeNumber(metrics.losses));
  const observedTrades = sampleSize || (wins + losses);
  const pnl = safeNumber(metrics.pnl_pct);
  const maxDrawdown = Math.abs(safeNumber(metrics.max_drawdown_pct));
  const rugsAvoided = Math.max(0, safeNumber(metrics.rugs_avoided));
  const slippage = Math.max(0, safeNumber(metrics.avg_slippage));
  const falsePositiveRate = clamp(safeNumber(metrics.false_positive_rate), 0, 1);
  const winRate = observedTrades > 0
    ? wins / observedTrades
    : clamp(safeNumber(metrics.win_rate), 0, 1);

  const qualityScore = clamp(
    50 + pnl * 0.8 + (winRate - 0.5) * 30 - maxDrawdown * 0.7 - slippage * 8 - falsePositiveRate * 25 + Math.min(10, rugsAvoided * 1.5),
    0,
    100
  );

  return {
    sample_size: observedTrades,
    wins,
    losses,
    pnl_pct: Number(pnl.toFixed(2)),
    win_rate: Number(winRate.toFixed(4)),
    max_drawdown_pct: Number(maxDrawdown.toFixed(2)),
    avg_hold_minutes: Number(safeNumber(metrics.avg_hold_minutes).toFixed(2)),
    avg_slippage: Number(slippage.toFixed(4)),
    false_positive_rate: Number(falsePositiveRate.toFixed(4)),
    rugs_avoided: rugsAvoided,
    tail_capture_pct: Number(safeNumber(metrics.tail_capture_pct).toFixed(2)),
    quality_score: Number(qualityScore.toFixed(2)),
  };
}

function computeExperimentSummary(experiment, runs) {
  const baselineRuns = runs.filter((run) => run.variant === "baseline");
  const candidateRuns = runs.filter((run) => run.variant === "candidate");
  const latestRun = runs.length ? runs[runs.length - 1] : null;

  const totals = runs.reduce((acc, run) => {
    acc.sample_size += safeNumber(run.metrics.sample_size);
    acc.wins += safeNumber(run.metrics.wins);
    acc.losses += safeNumber(run.metrics.losses);
    return acc;
  }, { sample_size: 0, wins: 0, losses: 0 });

  const average = (list, field) => {
    if (!list.length) return 0;
    return list.reduce((sum, item) => sum + safeNumber(item.metrics[field]), 0) / list.length;
  };

  const baselineAvg = baselineRuns.length ? {
    pnl_pct: average(baselineRuns, "pnl_pct"),
    win_rate: average(baselineRuns, "win_rate"),
    max_drawdown_pct: average(baselineRuns, "max_drawdown_pct"),
    quality_score: average(baselineRuns, "quality_score"),
  } : null;

  const candidateAvg = candidateRuns.length ? {
    pnl_pct: average(candidateRuns, "pnl_pct"),
    win_rate: average(candidateRuns, "win_rate"),
    max_drawdown_pct: average(candidateRuns, "max_drawdown_pct"),
    quality_score: average(candidateRuns, "quality_score"),
  } : null;

  const comparison = baselineAvg && candidateAvg ? {
    pnl_lift_pct: Number((candidateAvg.pnl_pct - baselineAvg.pnl_pct).toFixed(2)),
    win_rate_lift: Number((candidateAvg.win_rate - baselineAvg.win_rate).toFixed(4)),
    drawdown_delta_pct: Number((candidateAvg.max_drawdown_pct - baselineAvg.max_drawdown_pct).toFixed(2)),
    quality_lift: Number((candidateAvg.quality_score - baselineAvg.quality_score).toFixed(2)),
  } : null;

  let recommendation = "insufficient_data";
  if ((totals.sample_size || 0) >= (experiment.minimum_sample_size || 0)) {
    if (comparison && comparison.quality_lift >= 5 && comparison.drawdown_delta_pct <= 2) recommendation = "promote_candidate";
    else if (comparison && comparison.quality_lift <= -5) recommendation = "keep_baseline";
    else recommendation = "review_manually";
  }

  return {
    run_count: runs.length,
    sample_size: totals.sample_size,
    wins: totals.wins,
    losses: totals.losses,
    baseline: baselineAvg,
    candidate: candidateAvg,
    comparison,
    latest_run_at: latestRun?.ts || null,
    recommendation,
  };
}

export function createExperiment({
  name,
  hypothesis,
  baseline_rule,
  candidate_rule,
  owner = "unknown",
  status = "draft",
  minimum_sample_size = 30,
  tags = [],
  notes = "",
} = {}) {
  if (!name || !hypothesis || !baseline_rule || !candidate_rule) {
    return { error: "name, hypothesis, baseline_rule, and candidate_rule are required" };
  }
  const data = loadExperiments();
  const experiment = {
    id: data.next_id,
    name: String(name).slice(0, 160),
    hypothesis: String(hypothesis).slice(0, 500),
    baseline_rule: String(baseline_rule).slice(0, 500),
    candidate_rule: String(candidate_rule).slice(0, 500),
    owner: String(owner),
    status: String(status),
    minimum_sample_size: Math.max(1, Math.floor(safeNumber(minimum_sample_size, 30))),
    tags: normalizeTags(tags),
    notes: String(notes || "").slice(0, 2000),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  data.experiments.push(experiment);
  data.next_id += 1;
  saveExperiments(data);
  return experiment;
}

export function updateExperimentStatus({ id, status, notes } = {}) {
  const data = loadExperiments();
  const experiment = data.experiments.find((item) => item.id === Number(id));
  if (!experiment) return { error: `Experiment ${id} not found` };
  if (status) experiment.status = String(status);
  if (typeof notes === "string" && notes.trim()) {
    experiment.notes = [experiment.notes, notes.trim()].filter(Boolean).join("\n\n").slice(0, 4000);
  }
  experiment.updated_at = nowIso();
  saveExperiments(data);
  return experiment;
}

export function recordExperimentRun({
  experiment_id,
  variant,
  sample_size,
  wins,
  losses,
  pnl_pct,
  max_drawdown_pct,
  avg_hold_minutes = 0,
  avg_slippage = 0,
  false_positive_rate = 0,
  rugs_avoided = 0,
  tail_capture_pct = 0,
  notes = "",
  context = {},
} = {}) {
  const data = loadExperiments();
  const experiment = data.experiments.find((item) => item.id === Number(experiment_id));
  if (!experiment) return { error: `Experiment ${experiment_id} not found` };
  if (!["baseline", "candidate"].includes(variant)) return { error: "variant must be baseline or candidate" };

  const run = {
    ts: nowIso(),
    experiment_id: Number(experiment_id),
    variant,
    metrics: computeRunDerivedMetrics({
      sample_size, wins, losses, pnl_pct, max_drawdown_pct, avg_hold_minutes,
      avg_slippage, false_positive_rate, rugs_avoided, tail_capture_pct,
    }),
    notes: String(notes || "").slice(0, 2000),
    context: context && typeof context === "object" ? context : {},
  };

  appendRun(run);
  experiment.updated_at = nowIso();
  saveExperiments(data);
  return { run, summary: getExperimentSummary({ id: experiment.id }) };
}

export function listExperiments({ status, tag, limit = 20 } = {}) {
  const data = loadExperiments();
  let experiments = [...data.experiments];
  if (status) experiments = experiments.filter((item) => item.status === status);
  if (tag) experiments = experiments.filter((item) => item.tags.includes(tag));
  return experiments
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, limit);
}

export function getExperimentSummary({ id } = {}) {
  const data = loadExperiments();
  const experiment = data.experiments.find((item) => item.id === Number(id));
  if (!experiment) return { error: `Experiment ${id} not found` };
  const runs = loadRuns().filter((run) => run.experiment_id === experiment.id);
  return { experiment, summary: computeExperimentSummary(experiment, runs), runs };
}

export function getExperimentOverview({ limit = 10 } = {}) {
  return listExperiments({ limit }).map((experiment) => {
    const summary = getExperimentSummary({ id: experiment.id });
    return {
      id: experiment.id,
      name: experiment.name,
      status: experiment.status,
      owner: experiment.owner,
      updated_at: experiment.updated_at,
      recommendation: summary?.summary?.recommendation || "insufficient_data",
      sample_size: summary?.summary?.sample_size || 0,
      comparison: summary?.summary?.comparison || null,
    };
  });
}

export function _resetExperimentsForTests() {
  if (fs.existsSync(EXPERIMENTS_FILE)) fs.unlinkSync(EXPERIMENTS_FILE);
  if (fs.existsSync(RUNS_FILE)) fs.unlinkSync(RUNS_FILE);
}
