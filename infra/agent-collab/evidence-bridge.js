import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getExperimentSummary,
  listExperiments,
  recordExperimentRun,
  setExperimentEvidenceSource,
} from "./experiment-tracker.js";

// Experiment-evidence bridge.
//
// The collaboration layer's experiments were starving: the bot accumulates
// real outcomes in performance.json, but runs only existed when someone
// remembered to call record_experiment_run by hand (6 manual runs across 11
// experiments as of 2026-06-11 — 10 of them stuck at insufficient_data).
//
// This bridge records one delta-window run per opted-in experiment per
// invocation: only trades closed AFTER the previous bridge run's cursor (or
// the experiment's created_at for the first run) are counted, so repeated
// invocations never double-count a trade into the summed sample_size.
//
// Honesty constraint: the live book runs the candidate rule only — there is
// no concurrent baseline arm. Bridge runs are recorded as variant=candidate
// with that caveat in the notes, so a matured experiment lands on
// review_manually (a Claude judgment with real data), never on an automatic
// promote from a fake A/B.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERF_FILE = process.env.PONYOU_PERF_FILE || path.join(__dirname, "../../performance.json");
const SKILL_ATTR_FILE = process.env.PONYOU_SKILL_ATTRIBUTION_FILE || path.join(__dirname, "../../skill-attribution.json");

const LIVE_STATUSES = new Set(["running", "active", "shadow"]);

function loadClosedTrades() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PERF_FILE, "utf8"));
    return Array.isArray(parsed?.trades) ? parsed.trades : [];
  } catch {
    return [];
  }
}

// Per-skill P&L attribution rows written by the portfolio manager. Shaped
// into the same {ts, win, pnl} contract as closed trades so the window logic
// is shared; skillIds ride along for the per-skill breakdown in run notes.
function loadSkillAttributionEntries() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILL_ATTR_FILE, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries.map((e) => ({
      ts: e.ts,
      win: !!e.win,
      pnl_pct: Number(e.pnl_pct) || 0,
      sol_pnl_pct: Number(e.pnl_pct) || 0,
      hold_minutes: 0,
      rug_detected: false,
      skillIds: Array.isArray(e.skillIds) ? e.skillIds : [],
    }));
  } catch {
    return [];
  }
}

function tradePnl(trade) {
  const v = Number(trade.sol_pnl_pct ?? trade.pnl_pct);
  return Number.isFinite(v) ? v : 0;
}

// Peak-to-trough drawdown of the cumulative per-trade pnl curve, in pct points.
function maxDrawdown(trades) {
  let cum = 0;
  let peak = 0;
  let worst = 0;
  for (const trade of trades) {
    cum += tradePnl(trade);
    peak = Math.max(peak, cum);
    worst = Math.max(worst, peak - cum);
  }
  return worst;
}

const SOURCE_KINDS = new Set(["closed_trades", "skill_attribution"]);

export function runEvidenceBridge() {
  const experiments = listExperiments({ limit: 100 }).filter(
    (exp) => LIVE_STATUSES.has(exp.status) && SOURCE_KINDS.has(exp.evidence_source?.kind)
  );
  const tradesByKind = {
    closed_trades: loadClosedTrades(),
    skill_attribution: loadSkillAttributionEntries(),
  };
  const results = [];

  for (const exp of experiments) {
    const kind = exp.evidence_source.kind;
    const trades = tradesByKind[kind];
    const { runs } = getExperimentSummary({ id: exp.id });
    const bridgeRuns = runs.filter((run) => run.context?.evidence_bridge);
    const cursor = bridgeRuns.length
      ? bridgeRuns[bridgeRuns.length - 1].context.window_until
      : exp.created_at;

    const windowTrades = trades
      .filter((trade) => trade.ts && trade.ts > cursor)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    if (windowTrades.length === 0) {
      results.push({ experiment_id: exp.id, name: exp.name, recorded: false, reason: "no_new_closed_trades", cursor });
      continue;
    }

    const wins = windowTrades.filter((trade) => trade.win).length;
    const losses = windowTrades.length - wins;
    const rugs = windowTrades.filter((trade) => trade.rug_detected).length;
    const avgPnl = windowTrades.reduce((sum, trade) => sum + tradePnl(trade), 0) / windowTrades.length;
    const avgHold = windowTrades.reduce((sum, trade) => sum + (Number(trade.hold_minutes) || 0), 0) / windowTrades.length;
    const windowUntil = windowTrades[windowTrades.length - 1].ts;

    const { run, summary, error } = recordExperimentRun({
      experiment_id: exp.id,
      variant: "candidate",
      sample_size: windowTrades.length,
      wins,
      losses,
      pnl_pct: avgPnl,
      max_drawdown_pct: maxDrawdown(windowTrades),
      avg_hold_minutes: avgHold,
      notes:
        `auto evidence-bridge window ${cursor} → ${windowUntil}: ${windowTrades.length} ${kind === "skill_attribution" ? "skill-attributed trades" : "closed trades (whole live book)"} ` +
        `(candidate rule live with NO concurrent baseline arm — ` +
        `evidence for manual review, not an A/B promote signal). rugs_detected=${rugs}` +
        (kind === "skill_attribution" ? ` per-skill: ${_skillBreakdown(windowTrades)}` : ""),
      context: { evidence_bridge: true, source_kind: kind, window_from: cursor, window_until: windowUntil, rugs_detected: rugs },
    }) || {};

    results.push({
      experiment_id: exp.id,
      name: exp.name,
      recorded: !error,
      error: error || undefined,
      window: { from: cursor, until: windowUntil, trades: windowTrades.length, wins, losses },
      recommendation: summary?.summary?.recommendation,
      total_sample: summary?.summary?.sample_size,
      run_ts: run?.ts,
    });
  }

  return { perf_file: PERF_FILE, experiments_checked: experiments.length, results };
}

// "skill=wr%/n" summary per skill in a window, for run notes.
function _skillBreakdown(windowTrades) {
  const bySkill = {};
  for (const t of windowTrades) {
    for (const id of t.skillIds || []) {
      if (!bySkill[id]) bySkill[id] = { n: 0, wins: 0 };
      bySkill[id].n++;
      if (t.win) bySkill[id].wins++;
    }
  }
  return Object.entries(bySkill)
    .map(([id, s]) => `${id}=${((s.wins / s.n) * 100).toFixed(0)}%/${s.n}`)
    .join(" ") || "none";
}

// Kinds the bridge can be POINTED at. The bridge only ACTS on SOURCE_KINDS;
// counterfactual_twin / screening_precision experiments are deliberately
// skipped here — their evidence accrues in the cf:* twin (replay) or in run
// notes, so live closes are no longer double-attributed to them.
const SETTABLE_KINDS = new Set([...SOURCE_KINDS, "counterfactual_twin", "screening_precision"]);

export function enableEvidence(ids, kind = "closed_trades", extras = {}) {
  if (!SETTABLE_KINDS.has(kind)) return [{ error: `unknown kind: ${kind}` }];
  return ids.map((id) => {
    const r = setExperimentEvidenceSource({ id, source: { kind, ...extras } });
    return r.error ? { id, error: r.error } : { id: r.id, name: r.name, evidence_source: r.evidence_source };
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const enableFlag = process.argv.indexOf("--enable");
  if (enableFlag !== -1) {
    const ids = String(process.argv[enableFlag + 1] || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter(Number.isFinite);
    const kindFlag = process.argv.indexOf("--kind");
    const kind = kindFlag !== -1 ? String(process.argv[kindFlag + 1] || "closed_trades") : "closed_trades";
    console.log(JSON.stringify(enableEvidence(ids, kind), null, 2));
  } else {
    console.log(JSON.stringify(runEvidenceBridge(), null, 2));
  }
}
