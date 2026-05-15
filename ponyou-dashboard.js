#!/usr/bin/env node

/**
 * PONYOU DASHBOARD - Real-time monitoring and analytics
 * Shows live metrics, performance, and system status
 *
 * Usage:
 *   node ponyou-dashboard.js
 */

import fs from "fs";

// ANSI Colors
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
};

function clearScreen() {
  console.clear();
}

function drawBox(title, content) {
  const lines = content.split("\n");
  const maxLen = Math.max(...lines.map((l) => l.length), title.length) + 4;

  console.log(`${colors.cyan}┌${"─".repeat(maxLen)}┐${colors.reset}`);
  console.log(
    `${colors.cyan}│${colors.bright} ${title.padEnd(maxLen - 2)} ${colors.reset}${colors.cyan}│${colors.reset}`
  );
  console.log(`${colors.cyan}├${"─".repeat(maxLen)}┤${colors.reset}`);

  lines.forEach((line) => {
    console.log(
      `${colors.cyan}│${colors.reset} ${line.padEnd(maxLen - 2)} ${colors.cyan}│${colors.reset}`
    );
  });

  console.log(`${colors.cyan}└${"─".repeat(maxLen)}┘${colors.reset}`);
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

function drawDashboard() {
  clearScreen();

  const config = loadConfig();
  const state = loadState();
  const perf = loadPerformance();
  const lessons = loadLessons();

  // Header
  console.log(`${colors.cyan}${colors.bright}`);
  console.log(
    "╔════════════════════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║                      PONYOU TRADING DASHBOARD                             ║"
  );
  console.log(
    "╚════════════════════════════════════════════════════════════════════════════╝"
  );
  console.log(colors.reset);

  // 1. Status Section
  const positions = Object.keys(state.positions || {}).length;
  const statusContent = `
    Status: ${positions > 0 ? `${colors.green}TRADING${colors.reset}` : `${colors.dim}IDLE${colors.reset}`}
    Open Positions: ${positions}
    Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}
    Configuration: ${config.llmProvider ? "✅" : "❌"}
  `;
  drawBox("STATUS", statusContent.trim());

  // 2. Performance Section
  const trades = perf.trades || [];
  const wins = trades.filter((t) => t.win).length;
  const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : "0";
  const avgPnl =
    trades.length > 0
      ? (trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length).toFixed(2)
      : "0";

  const perfContent = `
    Total Trades: ${trades.length}
    Win Rate: ${colors.green}${winRate}%${colors.reset} (${wins}W/${trades.length - wins}L)
    Avg P&L: ${formatPercentage(parseFloat(avgPnl))}
    Recent: ${trades.slice(-1)[0]?.pnl_pct ? formatPercentage(trades.slice(-1)[0].pnl_pct) : "N/A"}
  `;
  drawBox("PERFORMANCE", perfContent.trim());

  // 3. Configuration Section
  const configContent = `
    LLM Provider: ${config.llmProvider || "not set"}
    Trading Capital: $${config.pilotCapitalUsd || "N/A"}
    Max Positions: ${config.maxPositions || 3}
    Stop Loss: ${config.stopLossPct || -15}%
    Daily Target: ${config.dailyTargetPct || 25}%
  `;
  drawBox("CONFIGURATION", configContent.trim());

  // 4. Learning Section
  const activeLesson = lessons.lessons
    ? lessons.lessons.filter((l) => !l.tags?.includes("deprecated")).length
    : 0;

  const learningContent = `
    Active Lessons: ${activeLesson}
    Total Lessons: ${lessons.lessons?.length || 0}
    Learning Mode: ${process.env.LEARNING_MODE ? "ON" : "OFF"}
    Last Updated: ${lessons.last_updated || "Never"}
  `;
  drawBox("LEARNING SYSTEM", learningContent.trim());

  // 5. Quick Actions
  console.log(`\n${colors.cyan}${colors.bright}QUICK ACTIONS:${colors.reset}`);
  console.log(`  1. Start Agent        4. View Logs        7. Export Data`);
  console.log(`  2. Configuration      5. Test Setup       8. Reset All`);
  console.log(`  3. LLM Provider       6. Performance      9. Exit\n`);
}

async function main() {
  // Auto-refresh every 5 seconds
  let running = true;

  const interval = setInterval(() => {
    drawDashboard();
  }, 5000);

  // Initial draw
  drawDashboard();

  // Listen for keyboard input to stop
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (key) => {
    if (key.toString() === "q" || key.toString() === "") {
      clearInterval(interval);
      process.exit(0);
    }
  });
}

main();
