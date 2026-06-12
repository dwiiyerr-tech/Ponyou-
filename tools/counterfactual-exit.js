/**
 * Counterfactual Exit Evaluator — replay each CLOSED position's price path
 * against alternative exit policies, producing paired A/B evidence for the
 * side of the trade nobody has instrumented: 11 of the first 13 live losses
 * were SL -12% or rugs, and PnL is decided at exit, not entry.
 *
 * Method (task #19 research, 2026-06-12):
 *   - BASELINE arm = the ACTUAL exit that happened (real outcome, not a sim).
 *     Candidate arm = an alternative policy replayed on the same price path —
 *     the most honest paired comparison available offline.
 *   - Candles come from GeckoTerminal via getTokenKlines({mint}) and are
 *     persisted into an append-only archive at capture time (GT minute data
 *     ages out in ~3.5 days, so fetch-at-replay would slowly lose coverage;
 *     capture-at-close keeps it at 100% forever).
 *   - Intrabar ambiguity uses the PESSIMISTIC convention: when a bar's low
 *     would trigger a stop and its high would extend the peak / hit a TP,
 *     the adverse fill is assumed first. Ambiguous bars are counted and
 *     reported so a verdict resting on them is visibly weaker.
 *   - Rug fills are clamped to -90%, the same explicit model the entry
 *     evaluator uses (SHADOW_RUG_RETURN_PCT) — candle lows on a rug print
 *     fantasy liquidity nobody actually got.
 *   - Results go to DEDICATED experiments (prefix "cf-exit:", tag
 *     "counterfactual") with delta-window cursors — never into live
 *     experiments, same evidence-hierarchy rule as the entry evaluator.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";
import {
  createExperiment,
  getExperimentSummary,
  listExperiments,
  recordExperimentRun,
} from "../infra/agent-collab/experiment-tracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolved at call time, not import time — demo redirects and test fixtures
// set these env vars after module load. Standalone CLIs (collab:start) run
// WITHOUT the bot's demo env redirect, so demo-redirected stores fall back to
// demo/<file> when it exists — that's where the paper bot's closes live.
const _demoAware = (envVar, fname) => () => {
  if (process.env[envVar]) return process.env[envVar];
  const demo = path.join(__dirname, "../demo", fname);
  return fs.existsSync(demo) ? demo : path.join(__dirname, "..", fname);
};
const STATE_FILE = _demoAware("PONYOU_STATE_FILE", "state.json");
const ARCHIVE_FILE = () => process.env.PONYOU_ARCHIVE_FILE || path.join(__dirname, "../closed-positions-archive.json");
const ATTRIB_FILE = _demoAware("PONYOU_TRADE_ATTRIBUTION_FILE", "trade-attribution.json");
const CANDLE_ARCHIVE_FILE = () => process.env.PONYOU_EXIT_CANDLE_ARCHIVE || path.join(__dirname, "../data/exit-candle-archive.json");

const RUG_CLAMP_PCT = -90;          // same model as entry evaluator's shadow rugs
const REPLAY_HORIZON_MS = 6 * 60 * 60 * 1000; // policies may hold longer than the actual exit
const CAPTURE_DELAY_MS = 1200;      // GT free-tier politeness, same budget as ATH proxy

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// ─── Closed-position dataset ─────────────────────────────────────────────────

/**
 * One replayable record per closed position:
 * { position_key, mint, symbol, entry_price, deployed_at, closed_at,
 *   peak_pnl_pct, actual_pnl_pct, is_rug }
 * actual_pnl_pct joins from trade-attribution (positions never carry pnl —
 * same join, same 48h same-mint window as the readiness gate).
 */
export function loadClosedPositions() {
  const state = readJson(STATE_FILE()) || {};
  const archive = readJson(ARCHIVE_FILE()) || [];
  const raw = [
    ...Object.values(state.positions || {}).filter((p) => p.closed),
    ...(Array.isArray(archive) ? archive : []),
  ];

  const attribByMint = new Map();
  for (const a of (readJson(ATTRIB_FILE())?.trades || [])) {
    if (!a?.mint || !Number.isFinite(Number(a.pnl_pct))) continue;
    if (!attribByMint.has(a.mint)) attribByMint.set(a.mint, []);
    attribByMint.get(a.mint).push(a);
  }

  const seen = new Set();
  const out = [];
  for (const p of raw) {
    const key = p.position_key || p.position || p.mint || "";
    const mint = String(key).split("::")[0];
    if (!mint || !p.closed_at || seen.has(`${mint}::${p.closed_at}`)) continue;
    seen.add(`${mint}::${p.closed_at}`);

    const entryPrice = Number(p.signal_snapshot?.entry_price) || 0;
    const closedTs = Date.parse(p.closed_at) || 0;
    let actual = null;
    let bestGap = Infinity;
    for (const a of (attribByMint.get(mint) || [])) {
      const gap = Math.abs((Date.parse(a.ts || "") || 0) - closedTs);
      if (gap < bestGap) { bestGap = gap; actual = a; }
    }
    const noteText = [
      ...(Array.isArray(p.notes) ? p.notes : [p.notes]),
      actual?.exit_reason,
    ].filter((s) => typeof s === "string").join(" ");

    out.push({
      position_key: p.position_key || key,
      mint,
      symbol: p.pool_name || actual?.symbol || mint.slice(0, 8),
      entry_price: entryPrice,
      deployed_at: p.deployed_at || null,
      closed_at: p.closed_at,
      peak_pnl_pct: Number(p.peak_pnl_pct) || 0,
      actual_pnl_pct: actual && bestGap <= 48 * 60 * 60 * 1000 ? Number(actual.pnl_pct) : null,
      is_rug: /rug|price_drop|honeypot/i.test(noteText),
    });
  }
  return out.sort((a, b) => String(a.closed_at).localeCompare(String(b.closed_at)));
}

// ─── Candle archive (capture-at-close) ───────────────────────────────────────

export function loadCandleArchive() {
  return readJson(CANDLE_ARCHIVE_FILE(), {}) || {};
}

function saveCandleArchive(archive) {
  fs.mkdirSync(path.dirname(CANDLE_ARCHIVE_FILE()), { recursive: true });
  atomicWriteJson(CANDLE_ARCHIVE_FILE(), archive);
}

/**
 * Fetch + persist the price path for every closed position not yet archived.
 * Resolution adapts to hold time so short scalps get 1m bars. Failures are
 * recorded as {error} so coverage is honest and re-attempted next run.
 */
export async function captureCandles({ fetcher = null, now = Date.now() } = {}) {
  const getKlines = fetcher || (await import("./dexscreener.js")).getTokenKlines;
  const archive = loadCandleArchive();
  const positions = loadClosedPositions();
  let captured = 0, failed = 0, skipped = 0;

  for (const p of positions) {
    if (archive[p.position_key]?.candles?.length) { skipped++; continue; }
    const deployTs = Date.parse(p.deployed_at || "") || null;
    const closeTs = Date.parse(p.closed_at) || now;
    const holdMin = deployTs ? (closeTs - deployTs) / 60000 : null;
    const resolution = holdMin != null && holdMin <= 120 ? "1m" : "5m";
    const barMs = resolution === "1m" ? 60_000 : 300_000;
    const needBars = Math.min(1000, Math.ceil(((closeTs + REPLAY_HORIZON_MS) - (deployTs || closeTs)) / barMs) + 12);

    try {
      const res = await getKlines({ mint: p.mint, resolution, limit: needBars });
      const candles = (res?.candles || []).filter((c) =>
        // keep one bar of context before entry through the replay horizon
        (!deployTs || c.time * 1000 >= deployTs - barMs) && c.time * 1000 <= closeTs + REPLAY_HORIZON_MS
      );
      if (candles.length === 0) {
        archive[p.position_key] = { mint: p.mint, resolution, captured_at: new Date(now).toISOString(), candles: [], error: res?.error || "no candles in window" };
        failed++;
      } else {
        archive[p.position_key] = { mint: p.mint, resolution, captured_at: new Date(now).toISOString(), candles };
        captured++;
      }
    } catch (e) {
      archive[p.position_key] = { mint: p.mint, resolution, captured_at: new Date(now).toISOString(), candles: [], error: e.message };
      failed++;
    }
    if (!fetcher) await new Promise((r) => setTimeout(r, CAPTURE_DELAY_MS));
  }

  saveCandleArchive(archive);
  return { captured, failed, skipped, total: positions.length };
}

// ─── Exit-policy replay ──────────────────────────────────────────────────────

/**
 * Replay one exit policy over a candle path.
 * policy: { sl_pct, trail: {activate_pct, drop_pct}|null, partial: {frac, at_pct}|null }
 * Returns { pnl_pct, exit_reason, bars, ambiguous_bars }.
 */
export function replayExitPolicy(policy, { candles, entryPrice, entryTs = 0 }) {
  if (!entryPrice || !candles?.length) return { pnl_pct: null, exit_reason: "no_data", bars: 0, ambiguous_bars: 0 };

  const pnlOf = (price) => ((price / entryPrice) - 1) * 100;
  let peakPnl = 0;
  let realized = 0;
  let remainingFrac = 1;
  let partialDone = !policy.partial;
  let ambiguous = 0;
  let bars = 0;

  const finish = (exitPnl, reason) => {
    const total = realized + remainingFrac * Math.max(exitPnl, RUG_CLAMP_PCT);
    return { pnl_pct: Number(total.toFixed(2)), exit_reason: reason, bars, ambiguous_bars: ambiguous };
  };

  for (const c of candles) {
    if (entryTs && c.time * 1000 < entryTs) continue;
    bars++;
    const lowPnl = pnlOf(c.low);
    const highPnl = pnlOf(c.high);

    const slHit = policy.sl_pct != null && lowPnl <= policy.sl_pct;
    const trailActive = policy.trail && peakPnl >= policy.trail.activate_pct;
    // trailing trigger evaluated against the PRE-bar peak (no look-ahead)
    const trailLevel = trailActive
      ? ((1 + peakPnl / 100) * (1 - policy.trail.drop_pct / 100) - 1) * 100
      : null;
    const trailHit = trailLevel != null && lowPnl <= trailLevel;
    const upside = highPnl > peakPnl || (!partialDone && highPnl >= policy.partial.at_pct);

    if ((slHit || trailHit) && upside) ambiguous++; // both directions inside one bar

    // Pessimistic order: adverse fills first.
    if (slHit && (!trailHit || policy.sl_pct >= trailLevel)) return finish(policy.sl_pct, "sl");
    if (trailHit) return finish(trailLevel, "trailing");

    if (!partialDone && highPnl >= policy.partial.at_pct) {
      realized += policy.partial.frac * policy.partial.at_pct;
      remainingFrac -= policy.partial.frac;
      partialDone = true;
    }
    if (highPnl > peakPnl) peakPnl = highPnl;
  }

  const last = candles[candles.length - 1];
  return finish(pnlOf(last.close), "horizon_timeout");
}

// ─── Policy registry ─────────────────────────────────────────────────────────
// CURRENT mirrors the live paper config (SL -12, trailing 5%/2%); each
// candidate changes exactly one variable so deltas are attributable.

export const CURRENT_POLICY = { sl_pct: -12, trail: { activate_pct: 5, drop_pct: 2 }, partial: null };

export const EXIT_POLICIES = {
  // Control scenario: the CURRENT nominal policy, replayed. Its delta vs the
  // actual outcomes isolates the EXECUTION GAP (sync misses, late detection,
  // -97% price_drop sweeps) from policy differences — first run measured
  // actual avg -43.9% while every replayed policy landed near -2..-5%, which
  // says the bot wasn't executing its own policy, not that the policy is bad.
  "cf-exit:current-replayed": { ...CURRENT_POLICY,
    rule: "kebijakan nominal saat ini (SL -12, trailing 5/2) di-replay — delta vs aktual = gap eksekusi murni" },
  "cf-exit:sl-8":      { ...CURRENT_POLICY, sl_pct: -8,
    rule: "SL -8 (ketat), trailing 5/2 tetap" },
  "cf-exit:sl-18":     { ...CURRENT_POLICY, sl_pct: -18,
    rule: "SL -18 (longgar), trailing 5/2 tetap" },
  "cf-exit:trail-8-3": { ...CURRENT_POLICY, trail: { activate_pct: 8, drop_pct: 3 },
    rule: "trailing aktif +8 drop 3%, SL -12 tetap" },
  "cf-exit:ptp-50-25": { ...CURRENT_POLICY, partial: { frac: 0.5, at_pct: 25 },
    rule: "partial-TP 50% di +25, sisanya SL -12 + trailing 5/2" },
};

// ─── Recording (delta-windowed, dedicated cf-exit experiments) ───────────────

function findOrCreateExitExperiment(name, policy) {
  const existing = listExperiments({ limit: 200 }).find((e) => e.name === name);
  if (existing) return existing;
  return createExperiment({
    name,
    hypothesis: `Kebijakan exit alternatif (${policy.rule}) vs exit aktual — replay path harga posisi closed. [COUNTERFACTUAL kline-replay grade; baseline = outcome NYATA, candidate = simulasi pada path yang sama; keputusan tetap butuh validasi live]`,
    baseline_rule: "exit aktual yang terjadi (SL -12 / trailing 5-2 / rug / ROI live)",
    candidate_rule: policy.rule,
    owner: "counterfactual-exit",
    status: "running",
    minimum_sample_size: 20,
    tags: ["counterfactual", "exit-policy"],
  });
}

export function runExitScenarios({ policies = Object.keys(EXIT_POLICIES) } = {}) {
  const archive = loadCandleArchive();
  const positions = loadClosedPositions();
  const results = [];

  const replayable = positions.filter((p) => {
    const a = archive[p.position_key];
    return p.entry_price > 0 && a?.candles?.length > 0;
  });
  const coverage = `${replayable.length}/${positions.length}`;

  for (const name of policies) {
    const policy = EXIT_POLICIES[name];
    if (!policy) { results.push({ scenario: name, error: "unknown policy" }); continue; }

    const exp = findOrCreateExitExperiment(name, policy);
    if (exp.error) { results.push({ scenario: name, error: exp.error }); continue; }

    const { runs } = getExperimentSummary({ id: exp.id });
    const cfRuns = runs.filter((r) => r.context?.cf_exit);
    const cursor = cfRuns.length ? cfRuns[cfRuns.length - 1].context.window_until : null;
    const windowPos = (cursor ? replayable.filter((p) => p.closed_at > cursor) : replayable)
      .filter((p) => p.actual_pnl_pct != null); // paired arms need the real outcome

    if (windowPos.length === 0) {
      results.push({ scenario: name, experiment_id: exp.id, recorded: false, reason: "no_new_replayable_closes", coverage });
      continue;
    }

    let ambiguousTotal = 0;
    const candidatePnls = [];
    const actualPnls = [];
    for (const p of windowPos) {
      const a = archive[p.position_key];
      const r = replayExitPolicy(policy, {
        candles: a.candles,
        entryPrice: p.entry_price,
        entryTs: Date.parse(p.deployed_at || "") || 0,
      });
      if (r.pnl_pct == null) continue;
      ambiguousTotal += r.ambiguous_bars;
      // Model floor -90% applied IDENTICALLY to both arms (finish() already
      // floors the candidate) — otherwise deep real rugs in the baseline
      // would make every candidate look better by model artifact.
      candidatePnls.push(r.pnl_pct);
      actualPnls.push(Math.max(p.actual_pnl_pct, RUG_CLAMP_PCT));
    }
    if (candidatePnls.length === 0) {
      results.push({ scenario: name, experiment_id: exp.id, recorded: false, reason: "no_replay_outputs", coverage });
      continue;
    }

    const window = { from: cursor || windowPos[0].closed_at, until: windowPos[windowPos.length - 1].closed_at, count: candidatePnls.length };
    const avg = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const armNote = (label, pnls) =>
      `cf-exit replay window ${window.from} → ${window.until} (${pnls.length} posisi, coverage ${coverage}): ` +
      `${label}, avg=${avg(pnls).toFixed(1)}%, wins=${pnls.filter((v) => v > 0).length}. ` +
      `Model: kline-replay (konvensi intrabar PESIMISTIS, ambiguous_bars=${ambiguousTotal}, rug clamp ${RUG_CLAMP_PCT}%). ` +
      `Backtest-grade — bukan pengganti validasi live.`;

    recordExperimentRun({
      experiment_id: exp.id, variant: "baseline",
      sample_size: actualPnls.length,
      wins: actualPnls.filter((v) => v > 0).length,
      losses: actualPnls.filter((v) => v <= 0).length,
      pnl_pct: avg(actualPnls),
      notes: armNote("baseline = exit AKTUAL", actualPnls),
      context: { cf_exit: true, window_from: window.from, window_until: window.until },
    });
    recordExperimentRun({
      experiment_id: exp.id, variant: "candidate",
      sample_size: candidatePnls.length,
      wins: candidatePnls.filter((v) => v > 0).length,
      losses: candidatePnls.filter((v) => v <= 0).length,
      pnl_pct: avg(candidatePnls),
      notes: armNote(`candidate = ${policy.rule}`, candidatePnls),
      context: { cf_exit: true, window_from: window.from, window_until: window.until },
    });

    results.push({
      scenario: name,
      experiment_id: exp.id,
      recorded: true,
      window,
      coverage,
      baseline_avg_pnl: Number(avg(actualPnls).toFixed(2)),
      candidate_avg_pnl: Number(avg(candidatePnls).toFixed(2)),
      delta_pnl: Number((avg(candidatePnls) - avg(actualPnls)).toFixed(2)),
      ambiguous_bars: ambiguousTotal,
      recommendation: getExperimentSummary({ id: exp.id }).summary.recommendation,
    });
  }

  return { positions_total: positions.length, replayable: replayable.length, results };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const captureOnly = process.argv.includes("--capture-only");
  const skipCapture = process.argv.includes("--no-capture");
  const main = async () => {
    const out = {};
    if (!skipCapture) out.capture = await captureCandles();
    if (!captureOnly) out.replay = runExitScenarios();
    console.log(JSON.stringify(out, null, 2));
  };
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
