#!/usr/bin/env node

/**
 * PONYOU COMPREHENSIVE MONITOR
 * Real-time monitoring dashboard dengan detailed metrics
 *
 * Usage:
 *   node ponyou-monitor.js
 */

import fs from "fs";
import path from "path";

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
};

function clearScreen() {
  console.clear();
}

function box(title, content, color = colors.cyan) {
  const lines = content.split("\n");
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length), stripAnsi(title).length) + 4;

  console.log(`${color}┌${"─".repeat(maxLen)}┐${colors.reset}`);
  console.log(
    `${color}│${colors.bright} ${title.padEnd(maxLen - 2)} ${colors.reset}${color}│${colors.reset}`
  );
  console.log(`${color}├${"─".repeat(maxLen)}┤${colors.reset}`);

  lines.forEach((line) => {
    const cleanLen = stripAnsi(line).length;
    const padding = maxLen - 2 - cleanLen;
    console.log(`${color}│${colors.reset} ${line}${" ".repeat(Math.max(0, padding))} ${color}│${colors.reset}`);
  });

  console.log(`${color}└${"─".repeat(maxLen)}┘${colors.reset}`);
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function loadConfig() {
  if (!fs.existsSync("user-config.json")) return {};
  try {
    return JSON.parse(fs.readFileSync("user-config.json", "utf8"));
  } catch {
    return {};
  }
}

function loadState() {
  if (!fs.existsSync("state.json")) return {};
  try {
    return JSON.parse(fs.readFileSync("state.json", "utf8"));
  } catch {
    return {};
  }
}

function loadPerformance() {
  if (!fs.existsSync("performance.json")) return { trades: [] };
  try {
    return JSON.parse(fs.readFileSync("performance.json", "utf8"));
  } catch {
    return { trades: [] };
  }
}

function loadLessons() {
  if (!fs.existsSync("lessons.json")) return { lessons: [] };
  try {
    return JSON.parse(fs.readFileSync("lessons.json", "utf8"));
  } catch {
    return { lessons: [] };
  }
}

function formatPercentage(pct) {
  if (pct > 0) return `${colors.green}+${pct.toFixed(2)}%${colors.reset}`;
  if (pct < 0) return `${colors.red}${pct.toFixed(2)}%${colors.reset}`;
  return `${pct.toFixed(2)}%`;
}

function formatNumber(num) {
  if (num === undefined || num === null) return "N/A";
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function calculateStats(trades) {
  if (!trades || trades.length === 0) {
    return {
      total: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgPnl: 0,
      totalPnl: 0,
      best: 0,
      worst: 0,
      consecutive: 0,
    };
  }

  const wins = trades.filter((t) => t.win).length;
  const losses = trades.length - wins;
  const pnls = trades.map((t) => t.pnl_pct);
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const avgPnl = totalPnl / trades.length;

  // Calculate consecutive wins
  let consecutive = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].win) {
      consecutive++;
    } else {
      break;
    }
  }

  return {
    total: trades.length,
    wins,
    losses,
    winRate: (wins / trades.length) * 100,
    avgPnl,
    totalPnl,
    best: Math.max(...pnls),
    worst: Math.min(...pnls),
    consecutive,
  };
}

function calculateRiskMetrics(state, trades) {
  const positions = Object.keys(state.positions || {}).length;
  const equity = state.equity || 0;
  const peakEquity = state.peakEquity || equity;

  const maxDrawdown = peakEquity > 0 ? ((equity - peakEquity) / peakEquity) * 100 : 0;

  // Sharpe ratio (per-trade approximation): mean / stddev of trade returns.
  const pnls = trades.map((t) => t.pnl_pct).filter(Number.isFinite);
  let sharpe = 0;
  if (pnls.length > 1) {
    const mean = pnls.reduce((s, p) => s + p, 0) / pnls.length;
    const variance = pnls.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / pnls.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) sharpe = mean / stdDev;
  }

  // Risk score: open exposure × (1 - recent win rate). Higher = riskier.
  const recent = pnls.slice(-20);
  const recentWinRate = recent.length > 0
    ? recent.filter(p => p > 0).length / recent.length
    : 0.5;
  const riskScore = positions * (1 - recentWinRate);

  return {
    positions,
    equity,
    peakEquity,
    maxDrawdown,
    sharpe: Number.isFinite(sharpe) ? sharpe : 0,
    riskScore: riskScore.toFixed(2),
  };
}

function drawMonitor() {
  clearScreen();

  // Header
  console.log(`${colors.cyan}${colors.bright}`);
  console.log(
    "╔═══════════════════════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║                   PONYOU COMPREHENSIVE MONITOR                                ║"
  );
  console.log(
    "╚═══════════════════════════════════════════════════════════════════════════════╝"
  );
  console.log(colors.reset);

  const config = loadConfig();
  const state = loadState();
  const perf = loadPerformance();
  const lessons = loadLessons();

  const trades = perf.trades || [];
  const stats = calculateStats(trades);
  const risk = calculateRiskMetrics(state, trades);

  // 1. Status Overview
  const positions = Object.keys(state.positions || {}).length;
  const statusColor = positions > 0 ? colors.green : colors.dim;
  box(
    "📊 STATUS OVERVIEW",
    `Current Status: ${statusColor}${positions > 0 ? "🟢 TRADING" : "🔴 IDLE"}${colors.reset}
Open Positions: ${positions} / ${config.maxPositions || 3}
Mode: ${process.env.DRY_RUN === "true" ? "🔵 DRY RUN" : "🔴 LIVE"}
Configuration: ${config.llmProvider ? "✅ Complete" : "❌ Incomplete"}
Last Update: ${new Date().toLocaleTimeString()}`,
    colors.cyan
  );

  // 2. Trading Performance
  const perfColor = stats.winRate > 55 ? colors.green : stats.winRate > 45 ? colors.yellow : colors.red;
  box(
    "📈 TRADING PERFORMANCE",
    `Total Trades: ${stats.total}
Wins: ${colors.green}${stats.wins}${colors.reset} | Losses: ${colors.red}${stats.losses}${colors.reset}
Win Rate: ${perfColor}${stats.winRate.toFixed(1)}%${colors.reset}
Avg P&L: ${formatPercentage(stats.avgPnl)}
Total P&L: ${formatPercentage(stats.totalPnl)}
Best Trade: ${formatPercentage(stats.best)}
Worst Trade: ${formatPercentage(stats.worst)}
Consecutive Wins: ${colors.green}${stats.consecutive}${colors.reset}`,
    colors.green
  );

  // 3. Risk Metrics
  const riskColor = risk.maxDrawdown < -10 ? colors.red : risk.maxDrawdown < -5 ? colors.yellow : colors.green;
  box(
    "⚠️  RISK METRICS",
    `Max Drawdown: ${riskColor}${risk.maxDrawdown.toFixed(2)}%${colors.reset}
Sharpe Ratio: ${risk.sharpe > 1 ? colors.green : colors.yellow}${risk.sharpe.toFixed(2)}${colors.reset}
Risk Score: ${risk.riskScore}
Position Utilization: ${(positions / (config.maxPositions || 3) * 100).toFixed(0)}%
Peak Equity: $${formatNumber(risk.peakEquity)}
Current Equity: $${formatNumber(risk.equity)}`,
    colors.red
  );

  // 4. Configuration
  box(
    "⚙️  CONFIGURATION",
    `Provider: ${config.llmProvider || "?"}
Model: ${config.llmModel || "default"}
Capital: $${config.pilotCapitalUsd || "?"}
Max Positions: ${config.maxPositions || 3}
Stop Loss: ${config.stopLossPct || -15}%
Take Profit: ${config.takeProfitPct || 5}%
Daily Target: ${config.dailyTargetPct || 25}%
Strategy: ${config.strategy || "instant_scalping"}`,
    colors.magenta
  );

  // 5. Learning System
  const activeLessons = lessons.lessons
    ? lessons.lessons.filter((l) => !l.tags?.includes("deprecated")).length
    : 0;

  // Top lessons by win rate
  let topLessons = "";
  if (lessons.lessons && lessons.lessons.length > 0) {
    const sorted = lessons.lessons
      .filter((l) => l.times_applied > 0)
      .sort((a, b) => {
        const aRate = a.success_count / (a.success_count + a.failure_count) || 0;
        const bRate = b.success_count / (b.success_count + b.failure_count) || 0;
        return bRate - aRate;
      })
      .slice(0, 3);

    topLessons = sorted
      .map((l) => {
        const rate = ((l.success_count / (l.success_count + l.failure_count)) * 100).toFixed(0);
        return `${rate}% - ${l.rule.substring(0, 40)}...`;
      })
      .join("\n");
  }

  box(
    "🧠 LEARNING SYSTEM",
    `Active Lessons: ${activeLessons} / ${lessons.lessons?.length || 0}
Learning Mode: ${process.env.LEARNING_MODE ? "ON" : "OFF"}
${topLessons ? `Top Lessons:\n${topLessons}` : "No lessons active"}`,
    colors.yellow
  );

  // 6. Recent Trades
  let recentTrades = "";
  if (trades.length > 0) {
    recentTrades = trades
      .slice(-5)
      .reverse()
      .map((t, i) => {
        const sym = (t.symbol || t.token?.symbol || "???").padEnd(6).slice(0, 6);
        const pnl = Number.isFinite(t.pnl_pct) ? formatPercentage(t.pnl_pct) : "  N/A";
        const mark = t.win ? "✓" : "✗";
        return `${i + 1}. ${sym} - ${pnl} ${mark}`;
      })
      .join("\n");
  }

  box(
    "📊 RECENT TRADES",
    recentTrades || "No trades yet",
    colors.blue
  );

  // 7. Position Details
  let positionDetails = "";
  if (positions > 0) {
    positionDetails = Object.entries(state.positions || {})
      .slice(0, 5)
      .map(([symbol, pos]) => {
        const pnl = pos.pnl || 0;
        const entryAmount = pos.entry_amount || 0;
        const pnlPct = entryAmount > 0 ? ((pnl / entryAmount) * 100).toFixed(2) : 0;
        return `${symbol.padEnd(12)} - Entry: $${formatNumber(entryAmount)} | P&L: ${formatPercentage(parseFloat(pnlPct))}`;
      })
      .join("\n");
  }

  box(
    "💼 OPEN POSITIONS",
    positionDetails || "No open positions",
    colors.magenta
  );

  // Footer
  console.log(
    `\n${colors.dim}🔄 Updates every 5 seconds. Press 'q' to quit.${colors.reset}\n`
  );
}

// Main loop
let running = true;

const interval = setInterval(() => {
  if (running) {
    drawMonitor();
  }
}, 5000);

// Initial draw
drawMonitor();

// Listen for quit (if TTY available)
try {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key) => {
      const char = key.toString();
      if (char === "q" || char === "Q") {
        clearInterval(interval);
        console.log(`${colors.green}👋 Monitor stopped${colors.reset}\n`);
        process.exit(0);
      }
    });
  }
} catch (e) {
  // TTY not available in this environment
}
