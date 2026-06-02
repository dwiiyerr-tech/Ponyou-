#!/usr/bin/env node
/**
 * refresh-brain.js — Ponyou Obsidian "second brain" vault generator.
 *
 * Reads live bot state and writes/overwrites the auto-generated sections
 * of the vault at /home/ubuntu/ponyou-brain/.
 *
 * Usage: node /home/ubuntu/ponyou/scripts/refresh-brain.js
 *
 * Writes:
 *   03-Performance/_auto-daily.md
 *   01-Strategies/_auto-evolved.md
 *   00-Overview/_auto-status.md
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");
const VAULT = "/home/ubuntu/ponyou-brain";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeVaultFile(relativePath, content) {
  const fullPath = path.join(VAULT, relativePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  console.log(`  ✓ Wrote: ${relativePath}`);
}

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function parseLogLines(logFile, windowMs = 60 * 60 * 1000) {
  const since = Date.now() - windowMs;
  try {
    const lines = fs.readFileSync(logFile, "utf8").split("\n");
    return lines.filter((l) => {
      const ts = l.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/)?.[1];
      return ts && new Date(ts).getTime() >= since;
    });
  } catch {
    return [];
  }
}

function countIn(lines, pattern) {
  return lines.filter((l) => pattern.test(l)).length;
}

function topEntries(obj, n = 5) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

// ─── Data Collection ──────────────────────────────────────────────────────────

console.log("📖 Reading bot state...");

const now = new Date();
const dateStr = now.toISOString().slice(0, 10);
const isoNow = now.toISOString();

// Trading plan
const tradingPlan = readJson(path.join(ROOT, "trading-plan.json")) || {};
const session = tradingPlan.session || {};
const planDay = tradingPlan.currentDay || 1;
const daySchedule = (tradingPlan.schedule || []).find((d) => d.day === planDay) || {};

// Supervisor state
const supervisorState = readJson(path.join(ROOT, "supervisor-state.json")) || {};
const agentRunning = supervisorState.agentRunning === true;
const agentPid = supervisorState.pid || "unknown";
const agentMode = supervisorState.mode || "unknown";

// Strategy registry (active)
const activeStrategy = readJson(path.join(ROOT, "active-strategy.json")) || {};
const strategyIds = activeStrategy.ids || [activeStrategy.id].filter(Boolean);
const primaryStrategy = activeStrategy.id || "unknown";

// Strategy skills registry
const skillsReg = readJson(path.join(ROOT, "strategy-skills.json")) || { skills: {} };
const skills = skillsReg.skills || {};

// Evolved strategies
const evolvedRegistry = readJson(path.join(ROOT, "data", "strategy-registry.json"));
const evolvedStrategies = Array.isArray(evolvedRegistry) ? evolvedRegistry : [];

// Chain intel
const chainIntel = readJson(path.join(ROOT, "market-chain-intel.json")) || { chains: {} };
const chains = chainIntel.chains || {};

// Git log (last 10 commits)
const gitLog = run("git log --oneline -10") || "(no git log available)";

// Log parsing (last 60 minutes)
const agentLog = path.join(ROOT, "logs", "supervisor", "agent-demo.log");
const supervisorLog = path.join(ROOT, "logs", "supervisor", "supervisor-demo.log");

// Also try today's dated log
const todayLog = path.join(ROOT, "logs", `agent-${dateStr}.log`);

let allLines = parseLogLines(agentLog);
if (allLines.length === 0 && fs.existsSync(todayLog)) {
  allLines = parseLogLines(todayLog);
}
const supervisorLines = parseLogLines(supervisorLog);

// Expedition metrics
const expeditions = allLines.filter((l) => /\[HUNTER\] Expedition #/.test(l));
const expeditionCount = expeditions.length;
let totalTokensHunted = 0;
const expSources = { gt: 0, gtr: 0, lb: 0, pf: 0, gt_total: 0 };
for (const line of expeditions) {
  const m = line.match(/(\d+) tokens/);
  if (m) totalTokensHunted += parseInt(m[1]);
  const gt = line.match(/(\d+)gt/); if (gt) expSources.gt += parseInt(gt[1]);
  const gtr = line.match(/(\d+)gtr/); if (gtr) expSources.gtr += parseInt(gtr[1]);
  const lb = line.match(/(\d+)lb/); if (lb) expSources.lb += parseInt(lb[1]);
  const pf = line.match(/(\d+)pf/); if (pf) expSources.pf += parseInt(pf[1]);
}

// Screening
const screeningCycles = countIn(allLines, /\[CRON\] Starting screening cycle/);
const trashBlocked = countIn(allLines, /\[TRASH_FILTER\] BLOCKED/);
const trashPassed = countIn(allLines, /\[TRASH_FILTER\] PASSED/);
const rugSkipCount = countIn(allLines, /\[FILTER\] .+: SKIP rug score/);
const deployCount = allLines.filter((l) =>
  /\[RULE.BASED\]|\[LLM\].*DEPLOY|Deployed.*symbol|DRY.RUN.*DEPLOY/i.test(l)
).length;
const noCandidate = countIn(allLines, /No candidates passed/);

// GMGN row risk
const gmgnEvaluated = countIn(allLines, /gmgn_row_risk_evaluated/);
const gmgnContributed = countIn(allLines, /gmgn_row_risk_contributed/);
const gmgnBlocked = countIn(allLines, /gmgn_row_risk_blocked/);

// Filter skip reasons
const filterSkips = allLines.filter(
  (l) => /\[FILTER\] .+: SKIP/.test(l) && !/rug score/.test(l)
);
const skipReasons = {};
for (const l of filterSkips) {
  const m = l.match(/SKIP (.+)$/);
  if (m) {
    const r = m[1].slice(0, 50);
    skipReasons[r] = (skipReasons[r] || 0) + 1;
  }
}

// Market condition
const marketLines = allLines.filter((l) => /\[MARKET\] Market:/.test(l));
const marketConditions = {};
for (const l of marketLines) {
  const m = l.match(/Market: (\w+)/);
  if (m) marketConditions[m[1]] = (marketConditions[m[1]] || 0) + 1;
}
const hottestChainLine = allLines.filter((l) => /Hottest chain:/.test(l)).slice(-1)[0];
const hottestChain = hottestChainLine?.match(/Hottest chain: (\w+)/)?.[1] || "sol";
const lastMarketCondition =
  marketLines.slice(-1)[0]?.match(/Market: (\w+)/)?.[1] || "unknown";

// Errors
const errors = allLines.filter(
  (l) =>
    /\[.*_error\]|\[.*_ERROR\]|ERROR|EXCEPTION|crash|CRASH/.test(l) &&
    !/SCREENING_CRON_ERROR/.test(l)
);
const errorTypes = {};
for (const l of errors) {
  const m = l.match(/\[(\w+_error|\w+_ERROR)\]/i);
  if (m) errorTypes[m[1]] = (errorTypes[m[1]] || 0) + 1;
}
const recentErrors = errors.slice(-10);

// Rug monitor
const autoBlacklisted = countIn(allLines, /Auto-blacklisted honeypot/);
const slowRugForce = countIn(allLines, /slow_rug_force_exit/);
const rugMonitorAlerts = allLines.filter(
  (l) => /\[RUG_MONITOR\]/.test(l) && !/enabled/.test(l)
).length;

// Restarts
const restarts = countIn(supervisorLines, /Agent exited with code/);
const crashLines = supervisorLines.filter((l) => /exited with code [^0]/.test(l));

// Klines
const klinesPrefetched = countIn(allLines, /Klines ready.*pre-fetched/);
const klinesFailed = countIn(allLines, /\[KLINE_WARN\]/);

console.log(`  Expeditions: ${expeditionCount}, Deploys: ${deployCount}, Errors: ${errors.length}`);

// ─── Generate: _auto-daily.md ─────────────────────────────────────────────────

console.log("\n📝 Writing _auto-daily.md...");

const topSkipRows = topEntries(skipReasons, 5)
  .map(([r, n]) => `| ${r} | ${n} |`)
  .join("\n") || "| _(no filter skips logged)_ | — |";

const chainRows = Object.entries(chains)
  .map(([c, d]) => `| ${c.toUpperCase()} | ${d.score ?? "?"} | ${d.condition ?? "?"} | $${((d.metrics?.vol_usd ?? 0) / 1000).toFixed(0)}K | ${d.metrics?.avg_swaps ?? "?"} |`)
  .join("\n") || "| _(no chain data)_ | — | — | — | — |";

const errorRows =
  recentErrors.length > 0
    ? recentErrors
        .slice(-5)
        .map((l) => `- \`${l.slice(0, 120).replace(/`/g, "'")}\``)
        .join("\n")
    : "_No errors in the last hour_";

const gmgnRow =
  gmgnEvaluated > 0
    ? `| Layer 2d evaluated | ${gmgnEvaluated} |\n| Layer 2d contributed | ${gmgnContributed} (${gmgnEvaluated > 0 ? Math.round((gmgnContributed / gmgnEvaluated) * 100) : 0}%) |\n| Layer 2d blocked | ${gmgnBlocked} |`
    : "| Layer 2d | _(no GMGN-discovered tokens in window)_ |";

const dailyContent = `---
tags: [performance, auto-generated]
updated: ${isoNow}
type: daily-report
---

# Daily Performance — ${dateStr}

> [!NOTE]
> Auto-generated by \`node /home/ubuntu/ponyou/scripts/refresh-brain.js\` at ${isoNow}. Run the script again to refresh.

---

## Session State

| Metric | Value |
|--------|-------|
| Day number | ${planDay} |
| Session date | ${session.date || dateStr} |
| Capital (session start) | $${(session.startCapitalUsd || 0).toFixed(2)} |
| Capital (current) | $${(session.currentCapitalUsd || 0).toFixed(2)} |
| Trades | ${session.tradesCount || 0} (${session.winCount || 0}W / ${session.lossCount || 0}L) |
| P&L | $${(session.profitUsd || 0).toFixed(2)} (${(session.profitPct || 0).toFixed(1)}%) |
| Day target | $${(daySchedule.target_usd || 0).toFixed(2)} (+${daySchedule.profit_pct || 25}%) |
| Consecutive losses | ${session.consecutiveLosses || 0} |

---

## Pipeline Health (Last Hour)

| Metric | Value |
|--------|-------|
| Agent running | ${agentRunning ? `Yes (PID ${agentPid})` : "NO — STOPPED"} |
| Mode | ${agentMode} |
| Supervisor restarts | ${restarts} |
| Crash events | ${crashLines.length} |
| Expeditions | ${expeditionCount} |
| Tokens hunted | ${totalTokensHunted} |
| GMGN trending | ${expSources.gt} |
| GMGN trenches | ${expSources.gtr} |
| LetsBonk | ${expSources.lb} |
| Pump.fun | ${expSources.pf} |
| Screening cycles | ${screeningCycles} |
| Trash blocked | ${trashBlocked} |
| Trash passed | ${trashPassed} |
| Rug skips | ${rugSkipCount} |
| Deploys | ${deployCount} |
| No-candidate cycles | ${noCandidate} |
| Klines prefetched | ${klinesPrefetched} |
| Klines failed | ${klinesFailed} |
| Errors (total) | ${errors.length} |

---

## Top Filter Reasons

| Reason | Count |
|--------|-------|
${topSkipRows}

---

## Market Intelligence

| Metric | Value |
|--------|-------|
| Current condition | ${lastMarketCondition} |
| Hottest chain | ${hottestChain} |
${Object.entries(marketConditions)
  .map(([c, n]) => `| Market ${c} | ${n}x |`)
  .join("\n")}

### Chain Scores

| Chain | Score | Condition | Vol | Avg Swaps |
|-------|-------|-----------|-----|-----------|
${chainRows}

---

## Layer 2d (GMGN Row Risk — Exp #1)

| Metric | Value |
|--------|-------|
${gmgnRow}

---

## Rug Protection

| Metric | Value |
|--------|-------|
| Rug monitor alerts | ${rugMonitorAlerts} |
| Auto-blacklisted honeypots | ${autoBlacklisted} |
| Slow rug force exits | ${slowRugForce} |

---

## Errors (Last Hour)

${errorRows}

${Object.keys(errorTypes).length > 0 ? `**Error type breakdown:** ${Object.entries(errorTypes).map(([t, n]) => `${t}=${n}`).join(", ")}` : ""}

---

## Recent Commits

\`\`\`
${gitLog}
\`\`\`

---

## Active Strategy

| Field | Value |
|-------|-------|
| Primary | ${primaryStrategy} |
| All active | ${strategyIds.join(", ")} |
`;

writeVaultFile("03-Performance/_auto-daily.md", dailyContent);

// ─── Generate: _auto-evolved.md ───────────────────────────────────────────────

console.log("📝 Writing _auto-evolved.md...");

let evolvedContent;

if (evolvedStrategies.length === 0) {
  evolvedContent = `---
tags: [strategies, evolved, auto-generated]
updated: ${isoNow}
type: auto-generated
---

# Evolved Strategies

> [!NOTE]
> Auto-generated by \`node /home/ubuntu/ponyou/scripts/refresh-brain.js\` at ${isoNow}.

---

_No evolved strategies found in \`data/strategy-registry.json\`. The evolution engine proposes variants after accumulating enough trade observations._
`;
} else {
  const activeEvolved = evolvedStrategies.filter((s) => s.status === "active");
  const candidateEvolved = evolvedStrategies.filter((s) => s.status === "candidate");
  const rejectedEvolved = evolvedStrategies.filter((s) => s.status === "rejected");

  const fmtStrategy = (s) => {
    const p = s.params || {};
    const f = p.filters || {};
    return [
      `### ${s.id} (v${s.version || 1})`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Status | ${s.status} |`,
      `| Type | ${s.type || "composite"} |`,
      `| Weight | ${s.weight ?? 0} |`,
      `| McAP range | $${f.min_mcap_usd?.toLocaleString() || "?"} – $${f.max_mcap_usd?.toLocaleString() || "?"} |`,
      `| Stop loss | ${p.stoploss ? `${(p.stoploss * 100).toFixed(0)}%` : "?"} |`,
      `| LLM | ${p.use_llm ? `Yes (min ${p.llm_min_confidence || 0}%)` : "No"} |`,
      `| Author | ${s.provenance?.author || "?"}  |`,
      `| Parent skills | ${(s.provenance?.parent_skills || []).join(", ") || "none"} |`,
      `| Experiment | ${s.provenance?.experiment_id || "none"} |`,
      `| Created | ${s.provenance?.created_at?.slice(0, 10) || "?"} |`,
      s.backtest_scorecard
        ? `| Backtest win rate | ${s.backtest_scorecard.win_rate ?? "?"}% |`
        : "",
      s.provenance?.note ? `\n> ${s.provenance.note}` : "",
      ``,
    ]
      .filter((l) => l !== "")
      .join("\n");
  };

  evolvedContent = `---
tags: [strategies, evolved, auto-generated]
updated: ${isoNow}
type: auto-generated
---

# Evolved Strategies

> [!NOTE]
> Auto-generated by \`node /home/ubuntu/ponyou/scripts/refresh-brain.js\` at ${isoNow}.

**Total:** ${evolvedStrategies.length} strategies — ${activeEvolved.length} active, ${candidateEvolved.length} candidate, ${rejectedEvolved.length} rejected

---

## Active Evolved

${activeEvolved.length > 0 ? activeEvolved.map(fmtStrategy).join("\n---\n\n") : "_None_"}

---

## Candidate Proposals

${candidateEvolved.length > 0 ? candidateEvolved.map(fmtStrategy).join("\n---\n\n") : "_None — run the bot longer to generate proposals_"}

> [!TIP]
> Approve a candidate via Telegram: \`/approve_<id>\`
> Reject a candidate via Telegram: \`/reject_<id>\`

---

## Rejected

${rejectedEvolved.length > 0 ? rejectedEvolved.map((s) => `- **${s.id}** — rejected at ${s.updated_at?.slice(0, 10) || "?"}`).join("\n") : "_None_"}
`;
}

writeVaultFile("01-Strategies/_auto-evolved.md", evolvedContent);

// ─── Generate: _auto-status.md ────────────────────────────────────────────────

console.log("📝 Writing _auto-status.md...");

// Determine open positions from state.json
const stateJson = readJson(path.join(ROOT, "state.json")) || {};
const positions = stateJson.positions || stateJson.openPositions || {};
const positionList = Object.values(positions);

const positionRows =
  positionList.length > 0
    ? positionList
        .map((p) => {
          const pnl = p.unrealizedPnlPct ?? p.pnlPct ?? 0;
          const pnlStr = pnl >= 0 ? `+${pnl.toFixed(1)}%` : `${pnl.toFixed(1)}%`;
          return `| ${p.symbol || p.mint?.slice(0, 8) || "?"} | ${p.chain || "sol"} | $${(p.entryPrice ?? 0).toFixed(6)} | $${(p.currentPrice ?? p.entryPrice ?? 0).toFixed(6)} | ${pnlStr} | ${p.strategy || "?"} |`;
        })
        .join("\n")
    : "| _(no open positions)_ | — | — | — | — | — |";

// Skill summary
const skillRows = Object.values(skills)
  .map((s) => {
    const f = s.params?.filters || {};
    const isInActive = strategyIds.includes(s.id);
    const statusIcon = isInActive
      ? s.id === primaryStrategy
        ? "🟢 PRIMARY"
        : "🟡 Available"
      : "⚪ Off";
    return `| ${s.id} | ${statusIcon} | $${f.min_mcap_usd?.toLocaleString() || "?"} – $${f.max_mcap_usd?.toLocaleString() || "?"} | ${s.params?.stoploss ? `${(s.params.stoploss * 100).toFixed(0)}%` : "?"} | ${s.params?.use_llm ? "Yes" : "No"} |`;
  })
  .join("\n");

const statusContent = `---
tags: [status, auto-generated]
updated: ${isoNow}
type: auto-status
---

# Bot Status Snapshot

> [!NOTE]
> Auto-generated by \`node /home/ubuntu/ponyou/scripts/refresh-brain.js\` at ${isoNow}.

---

## Agent Health

| Field | Value |
|-------|-------|
| Agent running | ${agentRunning ? `Yes` : "NO — STOPPED"} |
| PID | ${agentPid} |
| Mode | ${agentMode.toUpperCase()} |
| Supervisor restarts (1h) | ${restarts} |
| Crash events (1h) | ${crashLines.length} |

${!agentRunning ? `> [!WARNING]\n> **Agent is not running!** Start with: \`npm run agent:24x7:demo\`` : ""}

---

## Capital & Plan

| Field | Value |
|-------|-------|
| Current capital | $${(session.currentCapitalUsd || 0).toFixed(2)} |
| Session start | $${(session.startCapitalUsd || 0).toFixed(2)} |
| Session P&L | $${(session.profitUsd || 0).toFixed(2)} (${(session.profitPct || 0).toFixed(1)}%) |
| Plan day | ${planDay} of ${tradingPlan.days || 30} |
| Day target | $${(daySchedule.target_usd || 0).toFixed(2)} |
| Trades today | ${session.tradesCount || 0} (${session.winCount || 0}W / ${session.lossCount || 0}L) |
| Consecutive losses | ${session.consecutiveLosses || 0} |

---

## Open Positions (${positionList.length})

| Token | Chain | Entry | Current | PnL | Strategy |
|-------|-------|-------|---------|-----|---------|
${positionRows}

---

## Active Strategies

| Strategy | Status | McAP Range | Stop Loss | LLM |
|---------|--------|-----------|-----------|-----|
${skillRows || "| _(no skills loaded)_ | — | — | — | — |"}

---

## Chain Intel

| Chain | Score | Condition | Vol (24h) | Avg Swaps |
|-------|-------|-----------|-----------|-----------|
${chainRows}

**Hottest chain:** ${hottestChain.toUpperCase()}

---

## Recent Git History

\`\`\`
${gitLog}
\`\`\`
`;

writeVaultFile("00-Overview/_auto-status.md", statusContent);

// ─── Git sync (push jika remote sudah di-set) ────────────────────────────────

function gitSync() {
  try {
    const hasRemote = execSync("git -C /home/ubuntu/ponyou-brain remote -v 2>/dev/null", { encoding: "utf8" }).trim();
    if (!hasRemote) return;
    execSync("git -C /home/ubuntu/ponyou-brain add -A", { stdio: "pipe" });
    const diff = execSync("git -C /home/ubuntu/ponyou-brain status --porcelain", { encoding: "utf8" }).trim();
    if (!diff) return;
    const msg = `auto: vault refresh ${new Date().toISOString().slice(0, 16)}`;
    execSync(`git -C /home/ubuntu/ponyou-brain commit -m "${msg}"`, { stdio: "pipe" });
    execSync("git -C /home/ubuntu/ponyou-brain push", { stdio: "pipe" });
    console.log("  ✓ Git: committed + pushed");
  } catch (e) {
    console.log("  ⚠ Git sync skipped:", e.message?.split("\n")[0]);
  }
}
gitSync();

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log(`
Done! Vault updated at ${isoNow}

Files written:
  /home/ubuntu/ponyou-brain/03-Performance/_auto-daily.md
  /home/ubuntu/ponyou-brain/01-Strategies/_auto-evolved.md
  /home/ubuntu/ponyou-brain/00-Overview/_auto-status.md
`);
