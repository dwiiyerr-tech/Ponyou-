#!/usr/bin/env node
/**
 * hourly-report.js — Ponyou 3-day monitoring report (called every hour).
 * Covers: pipeline health, decisions, market intelligence, chain activity,
 * strategy performance, learning system, wallet tracking, errors, gaps.
 *
 * Usage: node scripts/hourly-report.js [--window=60] [--json]
 * --window=N  minutes of log to analyze (default 60)
 * --json      emit machine-readable JSON only
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const windowMin = parseInt(args.find(a => a.startsWith("--window="))?.slice(9) || "60", 10);
const jsonOnly = args.includes("--json");
const since = Date.now() - windowMin * 60_000;

// ─── Helpers ─────────────────────────────────────────────────────

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function parseLogLines(file, filter) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    return lines.filter(l => {
      const ts = l.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/)?.[1];
      if (!ts || new Date(ts).getTime() < since) return false;
      return !filter || filter(l);
    });
  } catch { return []; }
}

function countIn(lines, pattern) {
  return lines.filter(l => pattern.test(l)).length;
}

function extractLast(lines, pattern) {
  const matches = lines.filter(l => pattern.test(l));
  return matches[matches.length - 1] || null;
}

// ─── Data Collection ──────────────────────────────────────────────

const agentLog = path.join(ROOT, "logs/supervisor/agent-demo.log");
const supervisorLog = path.join(ROOT, "logs/supervisor/supervisor-demo.log");
const stateFile = path.join(ROOT, "data", "strategy-registry.json");
const chainIntelFile = path.join(ROOT, "market-chain-intel.json");
const supervisorState = readJson(path.join(ROOT, "supervisor-state.json")) || {};

// All recent log lines
const allLines = parseLogLines(agentLog);
const supervisorLines = parseLogLines(supervisorLog);

// ── Supervisor health ──
const agentRunning = supervisorState.agentRunning === true;
const agentPid = supervisorState.pid;
const restarts = countIn(supervisorLines, /Agent exited with code/);
const crashLines = supervisorLines.filter(l => /exited with code [^0]/.test(l));

// ── Expedition metrics ──
const expeditions = allLines.filter(l => /\[HUNTER\] Expedition #/.test(l));
const lastExpedition = expeditions[expeditions.length - 1] || null;
const expeditionCount = expeditions.length;

// Parse expedition token counts
let totalTokensHunted = 0;
let expeditionBreakdown = { s:0, pf:0, g:0, n:0, gk:0, sm:0, jp:0, gt:0, gtr:0, lb:0 };
for (const line of expeditions) {
  const m = line.match(/(\d+) tokens/);
  if (m) totalTokensHunted += parseInt(m[1]);
  const gt = line.match(/(\d+)gt/); if (gt) expeditionBreakdown.gt += parseInt(gt[1]);
  const gtr = line.match(/(\d+)gtr/); if (gtr) expeditionBreakdown.gtr += parseInt(gtr[1]);
  const lb = line.match(/(\d+)lb/); if (lb) expeditionBreakdown.lb += parseInt(lb[1]);
  const pf = line.match(/(\d+)pf/); if (pf) expeditionBreakdown.pf += parseInt(pf[1]);
}
const avgTokensPerExpedition = expeditionCount > 0 ? Math.round(totalTokensHunted / expeditionCount) : 0;

// ── Screening metrics ──
const screeningCycles = countIn(allLines, /\[CRON\] Starting screening cycle/);
const screeningTimeouts = countIn(allLines, /SCREENING_CRON_ERROR.*timeout/);
const trashBlocked = countIn(allLines, /\[TRASH_FILTER\] BLOCKED/);
const trashPassed = countIn(allLines, /\[TRASH_FILTER\] PASSED/);
const rugSkips = allLines.filter(l => /\[FILTER\] .+: SKIP rug score/.test(l));
const rugSkipCount = rugSkips.length;

// Extract rug scores for distribution
const rugScores = rugSkips.map(l => {
  const m = l.match(/SKIP rug score (\d+)/);
  return m ? parseInt(m[1]) : 0;
});
const avgRugScore = rugScores.length ? Math.round(rugScores.reduce((a,b)=>a+b,0)/rugScores.length) : 0;

// ── Deploy / trade decisions ──
const deployLines = allLines.filter(l => /\[RULE.BASED\]|\[LLM\].*DEPLOY|Deployed.*symbol|swap.*token_out|DRY.RUN.*DEPLOY/i.test(l));
const deployCount = deployLines.length;
const noCandidate = countIn(allLines, /No candidates passed/);

// ── GMGN row-risk experiment telemetry ──
const gmgnEvaluated = countIn(allLines, /gmgn_row_risk_evaluated/);
const gmgnContributed = countIn(allLines, /gmgn_row_risk_contributed/);
const gmgnBlocked = countIn(allLines, /gmgn_row_risk_blocked/);

// ── Market intelligence ──
const marketLines = allLines.filter(l => /\[MARKET\] Market:/.test(l));
const lastMarket = marketLines[marketLines.length - 1] || null;
const marketConditions = {};
for (const l of marketLines) {
  const m = l.match(/Market: (\w+)/);
  if (m) marketConditions[m[1]] = (marketConditions[m[1]] || 0) + 1;
}

// ── Chain intelligence ──
const chainRankingLines = allLines.filter(l => /Chain ranking:/.test(l));
const hottestChainLines = allLines.filter(l => /Hottest chain:/.test(l));
const lastHottestChain = hottestChainLines[hottestChainLines.length - 1] || null;
const chainIntel = readJson(chainIntelFile) || {};

// ── Pro Orchestrator ──
const proLines = allLines.filter(l => /\[PRO_ORCHESTRATOR\]/.test(l));
const proBlocked = countIn(allLines, /strategy creation blocked/);
const proGates = allLines.filter(l => /✗ \d\. /.test(l)).slice(-7); // last 7 failed gates

// ── Learning system ──
const learningLines = allLines.filter(l => /\[LEARNING\]/.test(l) && !/TRASH BLOCK free learn/.test(l));
const lessonsLearned = countIn(allLines, /\[LEARNING\] Mencatat \d+ observasi/);
const learningObs = allLines.filter(l => /\[LEARNING\] Mencatat/.test(l));
const totalObservations = learningObs.reduce((sum, l) => {
  const m = l.match(/Mencatat (\d+)/); return sum + (m ? parseInt(m[1]) : 0);
}, 0);

// ── Errors ──
const errors = allLines.filter(l => /\[.*_error\]|\[.*_ERROR\]|ERROR|EXCEPTION|crash|CRASH/.test(l)
  && !/SCREENING_CRON_ERROR/.test(l)); // already counted
const errorTypes = {};
for (const l of errors) {
  const m = l.match(/\[(\w+_error|\w+_ERROR)\]/i);
  if (m) errorTypes[m[1]] = (errorTypes[m[1]] || 0) + 1;
}

// ── Rug monitor ──
const rugMonitorAlerts = allLines.filter(l => /\[RUG_MONITOR\]/.test(l) && !/enabled/.test(l));
const autoBlacklisted = allLines.filter(l => /Auto-blacklisted honeypot/.test(l));
const slowRugForce = allLines.filter(l => /slow_rug_force_exit/.test(l));

// ── Intel blocks (FOMO, etc.) ──
const intelBlocks = allLines.filter(l => /\[INTEL_BLOCK\]/.test(l));
const fomoBlocks = intelBlocks.filter(l => /fomo/.test(l));

// ── Klines ──
const klinesFailed = allLines.filter(l => /\[KLINE_WARN\]/.test(l));
const klinesPrefetched = allLines.filter(l => /Klines ready.*pre-fetched/.test(l));

// ── Filter pass/fail reasons ──
const filterSkips = allLines.filter(l => /\[FILTER\] .+: SKIP/.test(l) && !/rug score/.test(l));
const skipReasons = {};
for (const l of filterSkips) {
  const m = l.match(/SKIP (.+)$/);
  if (m) { const r = m[1].slice(0, 40); skipReasons[r] = (skipReasons[r]||0)+1; }
}

// ── Social hunter ──
const socialScans = countIn(allLines, /\[SOCIAL_HUNTER\] Scan done/);
const socialBlocked = countIn(allLines, /\[SOCIAL_GATE_BLOCK\]/);

// ── Wallet signals ──
const walletSignals = allLines.filter(l => /\[WALLET_SIGNAL\]/.test(l));
const smartMoneyInjected = allLines.filter(l => /\[SCREENING\] Wallet ping injected \d+ candidates/.test(l));

// ── On-chain listener ──
const onchainPools = allLines.filter(l => /new pool detected/.test(l));
const onchainMints = allLines.filter(l => /new mint/.test(l));

// ── Strategy evolution ──
const evolved = readJson(stateFile) || [];
const activeEvolved = Array.isArray(evolved) ? evolved.filter(s => s.status === "active") : [];
const pendingEvolved = Array.isArray(evolved) ? evolved.filter(s => s.status === "candidate") : [];

// ─── Build Report ──────────────────────────────────────────────────

const now = new Date().toISOString();
const windowLabel = windowMin === 60 ? "last 1 hour" : `last ${windowMin} min`;

const report = {
  generated_at: now,
  window_minutes: windowMin,
  commit: "e4e71fa",

  // HEALTH
  health: {
    agent_running: agentRunning,
    agent_pid: agentPid,
    supervisor_restarts_in_window: restarts,
    crash_events: crashLines.length,
    screening_timeouts: screeningTimeouts,
    critical_errors: errors.length,
    error_types: errorTypes,
  },

  // PIPELINE THROUGHPUT
  pipeline: {
    expeditions: expeditionCount,
    avg_tokens_per_expedition: avgTokensPerExpedition,
    gmgn_trending_tokens: expeditionBreakdown.gt,
    gmgn_trenches_tokens: expeditionBreakdown.gtr,
    letsbonk_tokens: expeditionBreakdown.lb,
    pumpfun_tokens: expeditionBreakdown.pf,
    trash_blocked: trashBlocked,
    trash_passed: trashPassed,
    rug_skips: rugSkipCount,
    avg_rug_score_of_skipped: avgRugScore,
    screening_cycles: screeningCycles,
    intel_fomo_blocks: fomoBlocks.length,
    klines_prefetched: klinesPrefetched.length,
    klines_failed: klinesFailed.length,
  },

  // DEPLOY DECISIONS
  decisions: {
    deploys: deployCount,
    no_candidate_cycles: noCandidate,
    filter_skips_non_rug: filterSkips.length,
    top_skip_reasons: Object.entries(skipReasons).sort((a,b)=>b[1]-a[1]).slice(0,5),
  },

  // MARKET INTELLIGENCE
  market: {
    last_condition: lastMarket?.match(/Market: (\w+)/)?.[1] || "unknown",
    condition_distribution: marketConditions,
    chain_snapshots: chainIntel,
    hottest_chain: lastHottestChain?.match(/Hottest chain: (\w+)/)?.[1] || "sol",
    chain_ranking_updates: chainRankingLines.length,
  },

  // GMGN ROW-RISK EXPERIMENT
  experiment_gmgn_row_risk: {
    tokens_evaluated: gmgnEvaluated,
    layer2d_contributed: gmgnContributed,
    tokens_blocked_by_layer2d: gmgnBlocked,
    contribution_rate_pct: gmgnEvaluated > 0 ? Math.round(gmgnContributed/gmgnEvaluated*100) : 0,
  },

  // LEARNING SYSTEM
  learning: {
    observation_batches: lessonsLearned,
    total_observations: totalObservations,
    social_scans: socialScans,
    social_signals_blocked: socialBlocked,
  },

  // WALLET / SMART MONEY
  wallets: {
    smart_money_injection_cycles: smartMoneyInjected.length,
    wallet_signal_events: walletSignals.length,
    onchain_new_pools: onchainPools.length,
    onchain_new_mints: onchainMints.length,
  },

  // RUG PROTECTION
  rug_protection: {
    rug_monitor_alerts: rugMonitorAlerts.length,
    auto_blacklisted_honeypots: autoBlacklisted.length,
    slow_rug_force_exits: slowRugForce.length,
  },

  // PRO ORCHESTRATOR
  pro_orchestrator: {
    strategy_creation_blocked_count: proBlocked,
    last_failed_gates: proGates.map(l => l.match(/✗ \d+\. (.+)$/)?.[1]).filter(Boolean),
  },

  // STRATEGY EVOLUTION
  evolution: {
    active_evolved_strategies: activeEvolved.length,
    pending_proposals: pendingEvolved.length,
  },
};

// ─── Gap Analysis ─────────────────────────────────────────────────

const gaps = [];

if (!agentRunning) gaps.push("CRITICAL: agent not running");
if (crashLines.length > 0) gaps.push(`CRITICAL: ${crashLines.length} crash(es) in window`);
if (screeningTimeouts > 0) gaps.push(`HIGH: ${screeningTimeouts} screening timeout(s) — klines still too slow?`);
if (klinesFailed.length > 5) gaps.push(`MEDIUM: ${klinesFailed.length} klines failed (GeckoTerminal 429?) — consider reducing batch or adding retry`);
if (report.pipeline.letsbonk_tokens === 0 && expeditionCount > 0) gaps.push("MEDIUM: LetsBonk 0 tokens found — DEX identifier may need adjustment again");
if (deployCount === 0 && screeningCycles >= 3) gaps.push(`INFO: 0 deploys after ${screeningCycles} cycles — all tokens failing filters; check strategy mcap/flag thresholds vs current market`);
if (noCandidate > screeningCycles * 0.5) gaps.push(`INFO: ${noCandidate}/${screeningCycles} cycles found no candidates — market may be quiet or filters too strict`);
if (gmgnEvaluated === 0 && expeditionCount > 0) gaps.push("INFO: Layer 2d row-risk telemetry not firing — GMGN-discovered tokens may not be reaching screening");
if (report.wallets.smart_money_injection_cycles > 0 && report.decisions.deploys === 0) gaps.push("INFO: smart money injecting signals but no trades — conviction/LLM gate blocking all entries");
if (errors.length > 10) gaps.push(`MEDIUM: ${errors.length} error log entries — check error_types`);
if (report.market.hottest_chain === "sol" && chainRankingLines.length === 0 && expeditionCount > 0) gaps.push("INFO: chain ranking not logged — multi-chain may not be active (gmgnChains=sol only)");

report.gaps = gaps;
report.gap_count = gaps.length;

// ─── Output ───────────────────────────────────────────────────────

if (jsonOnly) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const sep = "═".repeat(60);
  const hr = "─".repeat(60);
  console.log(`\n${sep}`);
  console.log(`📊 PONYOU HOURLY REPORT — ${now.slice(0,19).replace("T"," ")} UTC`);
  console.log(`   Window: ${windowLabel} | Commit: e4e71fa | Mode: DEMO`);
  console.log(sep);

  // HEALTH
  const healthIcon = agentRunning ? "✅" : "🔴";
  console.log(`\n${healthIcon} HEALTH`);
  console.log(`   Agent: ${agentRunning ? `running (PID ${agentPid})` : "STOPPED"} | Restarts: ${restarts} | Crashes: ${crashLines.length}`);
  console.log(`   Errors: ${errors.length} | Screening timeouts: ${screeningTimeouts}`);
  if (Object.keys(errorTypes).length) console.log(`   Error types: ${JSON.stringify(errorTypes)}`);

  // PIPELINE
  console.log(`\n🔍 PIPELINE THROUGHPUT`);
  console.log(`   Expeditions: ${expeditionCount} | Avg tokens/exp: ${avgTokensPerExpedition}`);
  console.log(`   GMGN trending: ${expeditionBreakdown.gt} | trenches: ${expeditionBreakdown.gtr} | LetsBonk: ${expeditionBreakdown.lb}`);
  console.log(`   Trash: ${trashBlocked} blocked / ${trashPassed} passed | Rug skips: ${rugSkipCount} (avg score: ${avgRugScore})`);
  console.log(`   Screening cycles: ${screeningCycles} | FOMO blocks: ${fomoBlocks.length} | Klines OK: ${klinesPrefetched.length} / Failed: ${klinesFailed.length}`);

  // DECISIONS
  console.log(`\n🎯 TRADE DECISIONS`);
  console.log(`   Deploys: ${deployCount} | No-candidate cycles: ${noCandidate}/${screeningCycles}`);
  if (report.decisions.top_skip_reasons.length) {
    console.log(`   Top filter reasons: ${report.decisions.top_skip_reasons.map(([r,n])=>`${r}(${n})`).join(", ")}`);
  }

  // MARKET
  console.log(`\n🌡️  MARKET INTELLIGENCE`);
  console.log(`   Current: ${report.market.last_condition} | Hottest chain: ${report.market.hottest_chain}`);
  console.log(`   Distribution: ${Object.entries(marketConditions).map(([c,n])=>`${c}=${n}`).join(" / ")}`);
  if (chainRankingLines.length) console.log(`   Chain rankings logged: ${chainRankingLines.length} times`);

  // EXPERIMENT
  if (gmgnEvaluated > 0) {
    console.log(`\n🧪 LAYER 2D (GMGN ROW RISK)`);
    console.log(`   Evaluated: ${gmgnEvaluated} | Contributed: ${gmgnContributed} (${report.experiment_gmgn_row_risk.contribution_rate_pct}%) | Blocked: ${gmgnBlocked}`);
  }

  // LEARNING
  console.log(`\n🧠 LEARNING SYSTEM`);
  console.log(`   Observation batches: ${lessonsLearned} | Total observations: ${totalObservations}`);
  console.log(`   Social scans: ${socialScans} | Signals blocked (large-cap): ${socialBlocked}`);

  // WALLETS
  console.log(`\n💼 WALLET / SMART MONEY`);
  console.log(`   Smart money injections: ${smartMoneyInjected.length} | Wallet events: ${walletSignals.length}`);
  console.log(`   On-chain: ${onchainPools.length} new pools | ${onchainMints.length} new mints`);

  // RUG PROTECTION
  if (rugMonitorAlerts.length + autoBlacklisted.length + slowRugForce.length > 0) {
    console.log(`\n🛡️  RUG PROTECTION`);
    console.log(`   Monitor alerts: ${rugMonitorAlerts.length} | Auto-blacklisted: ${autoBlacklisted.length} | Slow-rug exits: ${slowRugForce.length}`);
  }

  // PRO ORCHESTRATOR
  console.log(`\n🧠 PRO ORCHESTRATOR`);
  console.log(`   Strategy creation: ${proBlocked > 0 ? `BLOCKED (${proBlocked}x)` : "OK"}`);
  if (proGates.length) {
    proGates.forEach(l => {
      const m = l.match(/✗ \d+\. (.+)$/);
      if (m) console.log(`   ✗ ${m[1]}`);
    });
  }

  // EVOLUTION
  console.log(`\n🧬 STRATEGY EVOLUTION`);
  console.log(`   Active evolved: ${activeEvolved.length} | Pending proposals: ${pendingEvolved.length}`);

  // GAPS
  if (gaps.length > 0) {
    console.log(`\n⚠️  GAPS & PROBLEMS FOUND (${gaps.length})`);
    gaps.forEach(g => console.log(`   • ${g}`));
  } else {
    console.log(`\n✅ No gaps detected in this window`);
  }

  console.log(`\n${sep}\n`);
}
