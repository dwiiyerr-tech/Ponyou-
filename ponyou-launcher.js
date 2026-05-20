#!/usr/bin/env node

/**
 * PONYOU LAUNCHER - Legacy Terminal Control Menu
 * Auxiliary entry point for older terminal workflows
 * Primary surface is now `ponyou` (web dashboard)
 *
 * Usage:
 *   node ponyou-launcher.js
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";

// ANSI Colors
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgCyan: "\x1b[46m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
  bgMagenta: "\x1b[45m",
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

function getProcessStatus() {
  try {
    const state = loadState();
    // Only count positions with actual entry data (not test/stale entries)
    const active = Object.values(state.positions || {}).filter(
      p => p.entry_price || p.entry_usd || p.amount_sol
    );
    return active.length > 0 ? "TRADING" : "IDLE";
  } catch {
    return "IDLE";
  }
}

function drawSplashScreen() {
  clearScreen();
  console.log(
    `${colors.bgCyan}${colors.bright}                                                              ${colors.reset}`
  );
  console.log(
    `${colors.bgCyan}${colors.bright}              🐎 PONYOU - LEGACY TERMINAL CLI 🐎                ${colors.reset}`
  );
  console.log(
    `${colors.bgCyan}${colors.bright}                 Auxiliary launcher for terminal workflows         ${colors.reset}`
  );
  console.log(
    `${colors.bgCyan}${colors.bright}                                                              ${colors.reset}\n`
  );
}

async function question(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${colors.bright}${prompt}${colors.reset}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function spawnProcess(command, args, title) {
  return new Promise((resolve) => {
    console.log(`\n${colors.green}▶ ${title}${colors.reset}\n`);
    const proc = spawn("node", [command, ...args], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.log(`\n${colors.red}✗ Process exited with code ${code}${colors.reset}\n`);
      }
      resolve(code);
    });
  });
}

async function mainMenu() {
  while (true) {
    clearScreen();
    drawSplashScreen();

    const config = loadConfig();
    const state = loadState();
    const perf = loadPerformance();
    const status = getProcessStatus();

    // Status bar
    const positions = Object.keys(state.positions || {}).length;
    const statusColor = status === "TRADING" ? colors.green : colors.dim;
    const modeColor = process.env.DRY_RUN === "true" ? colors.yellow : colors.green;

    console.log(
      `${colors.dim}┌─ STATUS ${colors.reset}Status: ${statusColor}${status}${colors.reset} | ` +
      `Positions: ${positions} | Mode: ${modeColor}${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}${colors.reset} ${colors.dim}─┐${colors.reset}`
    );
    console.log(
      `${colors.dim}└─ CONFIG ${colors.reset}Provider: ${config.llmProvider || process.env.LLM_PROVIDER || (process.env.LLM_BASE_URL ? "local" : "openrouter")} | ` +
      `Capital: $${config.pilotCapitalUsd || "?"} | Max Pos: ${config.maxPositions || "?"} ${colors.dim}─┘${colors.reset}\n`
    );

    // Main menu
    const menuItems = [
      { id: "1", icon: "🚀", label: "Legacy Agent", desc: "Run trading agent" },
      { id: "2", icon: "📈", label: "Monitor", desc: "Legacy metrics view" },
      { id: "3", icon: "⚙️ ", label: "Configuration", desc: "Setup & settings" },
      { id: "4", icon: "🌐", label: "LLM Provider", desc: "Provider management" },
      { id: "5", icon: "🧪", label: "Test System", desc: "Validation & tests" },
      { id: "6", icon: "📚", label: "Documentation", desc: "Help & guides" },
      { id: "7", icon: "📁", label: "File Manager", desc: "Config files" },
      { id: "8", icon: "❌", label: "Exit", desc: "Quit legacy launcher" },
    ];

    console.log(`${colors.cyan}${colors.bright}MAIN MENU${colors.reset}\n`);

    menuItems.forEach((item) => {
      const colWidth = 35;
      const label = `${item.icon} ${item.label}`.padEnd(colWidth);
      console.log(
        `  ${colors.bright}${item.id}${colors.reset}. ${label} ${colors.dim}${item.desc}${colors.reset}`
      );
    });

    console.log("");
    const choice = await question("Pilih opsi (1-8): ");

    switch (choice) {
      case "1":
        await startAgent();
        break;
      case "2":
        await monitorMenu();
        break;
      case "3":
        await spawnProcess("ponyou-cli.js", [], "Configuration Menu");
        break;
      case "4":
        await llmProviderMenu();
        break;
      case "5":
        await testSystemMenu();
        break;
      case "6":
        await documentationMenu();
        break;
      case "7":
        await fileManagerMenu();
        break;
      case "8":
        clearScreen();
        console.log(`${colors.green}👋 Terima kasih telah menggunakan Ponyou!${colors.reset}\n`);
        process.exit(0);
      default:
        console.log(`${colors.red}Opsi tidak valid${colors.reset}`);
        await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function startAgent() {
  clearScreen();
  console.log(
    `${colors.cyan}${colors.bright}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`
  );
  console.log(`${colors.cyan}${colors.bright}  STARTING PONYOU TRADING AGENT${colors.reset}`);
  console.log(
    `${colors.cyan}${colors.bright}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`
  );

  const config = loadConfig();

  // Validation
  const checks = [
    ["Config file readable", fs.existsSync("user-config.json")],
    ["Environment variables loaded", !!process.env.LLM_PROVIDER || !!config.llmProvider],
    ["Trading capital configured", !!config.pilotCapitalUsd],
    ["Max positions configured", !!config.maxPositions],
  ];

  console.log(`${colors.cyan}${colors.bright}Pre-flight Checks:${colors.reset}\n`);
  checks.forEach(([check, status]) => {
    console.log(`  ${status ? colors.green : colors.red}${status ? "✓" : "✗"}${colors.reset} ${check}`);
  });

  const allValid = checks.every((c) => c[1]);
  if (!allValid) {
    console.log(`\n${colors.red}⚠ Some checks failed. Run Configuration first.${colors.reset}\n`);
    await question("Tekan Enter untuk kembali...");
    return;
  }

  console.log(
    `\n${colors.green}✓ All checks passed. Starting agent...${colors.reset}\n`
  );
  console.log(`${colors.dim}Tekan Ctrl+C untuk stop agent${colors.reset}\n`);

  await new Promise((resolve) => {
    const agent = spawn("npm", ["start"], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    agent.on("close", () => {
      resolve();
    });
  });
}

async function monitorMenu() {
  clearScreen();

  const config = loadConfig();
  const state = loadState();
  const perf = loadPerformance();
  const lessons = loadLessons();

  // Comprehensive monitoring data
  const positions = Object.keys(state.positions || {}).length;
  const trades = perf.trades || [];
  const wins = trades.filter((t) => t.win).length;
  const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : "0";
  const avgPnl =
    trades.length > 0 ? (trades.reduce((s, t) => s + t.pnl_pct, 0) / trades.length).toFixed(2) : "0";
  const totalPnl = trades.reduce((s, t) => s + t.pnl_pct, 0).toFixed(2);

  const activeLessons = lessons.lessons
    ? lessons.lessons.filter((l) => !l.tags?.includes("deprecated")).length
    : 0;

  clearScreen();
  console.log(`${colors.cyan}${colors.bright}COMPREHENSIVE MONITORING${colors.reset}\n`);

  // Trading Status
  box(
    "📊 TRADING STATUS",
    `Status: ${positions > 0 ? `${colors.green}TRADING${colors.reset}` : `${colors.dim}IDLE${colors.reset}`}
Open Positions: ${positions}
Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}
Configuration: ${config.llmProvider ? "✅" : "❌"}`,
    colors.cyan
  );

  // Performance
  box(
    "📈 PERFORMANCE METRICS",
    `Total Trades: ${trades.length}
Win Rate: ${colors.green}${winRate}%${colors.reset} (${wins}W/${trades.length - wins}L)
Avg P&L: ${formatPercentage(parseFloat(avgPnl))}
Total P&L: ${formatPercentage(parseFloat(totalPnl))}
Best Trade: ${trades.length > 0 ? formatPercentage(Math.max(...trades.map((t) => t.pnl_pct))) : "N/A"}
Worst Trade: ${trades.length > 0 ? formatPercentage(Math.min(...trades.map((t) => t.pnl_pct))) : "N/A"}
Recent: ${Number.isFinite(trades.slice(-1)[0]?.pnl_pct) ? formatPercentage(trades.slice(-1)[0].pnl_pct) : "N/A"}`,
    colors.green
  );

  // Configuration
  box(
    "⚙️  CONFIGURATION",
    `LLM Provider: ${config.llmProvider || "not set"}
LLM Model: ${config.llmModel || "default"}
Trading Capital: $${config.pilotCapitalUsd || "N/A"}
Max Positions: ${config.maxPositions || 3}
Stop Loss: ${config.stopLossPct || -15}%
Daily Target: ${config.dailyTargetPct || 25}%
Strategy: ${config.strategy || "instant_scalping"}`,
    colors.magenta
  );

  // Learning System
  box(
    "🧠 LEARNING SYSTEM",
    `Active Lessons: ${activeLessons}
Total Lessons: ${lessons.lessons?.length || 0}
Learning Mode: ${process.env.LEARNING_MODE ? "ON" : "OFF"}
Last Updated: ${lessons.last_updated || "Never"}`,
    colors.yellow
  );

  // Risk Summary
  const riskScore = positions * (1 - winRate / 100);
  box(
    "⚠️  RISK SUMMARY",
    `Current Exposure: ${positions} positions
Risk Score: ${riskScore.toFixed(1)} (lower is safer)
Drawdown from Peak: ${state.peakEquity ? ((state.equity - state.peakEquity) / state.peakEquity * 100).toFixed(2) : "N/A"}%
Sharpe Ratio: ${trades.length > 1 ? (avgPnl / 2.5).toFixed(2) : "N/A"}`,
    colors.red
  );

  console.log("");
  await question("Tekan Enter untuk kembali...");
}

async function llmProviderMenu() {
  clearScreen();
  console.log(`${colors.cyan}${colors.bright}LLM PROVIDER MANAGEMENT${colors.reset}\n`);

  const menuItems = [
    ["1", "🔄 Switch Provider", "spawnProcess('llm-cli.js', ['list'], 'Available Providers')"],
    ["2", "🔑 Set API Key", "spawnProcess('llm-cli.js', ['set-key'], 'Set Provider Key')"],
    ["3", "✅ Validate Config", "spawnProcess('llm-cli.js', ['validate'], 'Validate Configuration')"],
    ["4", "🧪 Test Connection", "spawnProcess('llm-cli.js', ['test'], 'Test Provider')"],
    ["5", "📚 Setup Wizard", "spawnProcess('setup-llm.js', [], 'LLM Setup Wizard')"],
    ["6", "📋 View Current", "spawnProcess('llm-cli.js', ['current'], 'Current Provider')"],
    ["7", "← Kembali", "return"],
  ];

  menuItems.forEach(([id, label]) => {
    console.log(`  ${colors.bright}${id}${colors.reset}. ${label}`);
  });

  console.log("");
  const choice = await question("Pilih opsi (1-7): ");

  switch (choice) {
    case "1":
      await spawnProcess("llm-cli.js", ["list"], "Available Providers");
      break;
    case "2":
      await spawnProcess("setup-llm.js", [], "LLM Setup Wizard");
      break;
    case "3":
      await spawnProcess("llm-cli.js", ["validate"], "Validate Configuration");
      break;
    case "4":
      await spawnProcess("llm-cli.js", ["test"], "Test Connection");
      break;
    case "5":
      await spawnProcess("setup-llm.js", [], "LLM Setup Wizard");
      break;
    case "6":
      await spawnProcess("llm-cli.js", ["current"], "Current Provider");
      break;
    case "7":
      return;
    default:
      console.log(`${colors.red}Opsi tidak valid${colors.reset}`);
  }
}

async function testSystemMenu() {
  clearScreen();
  console.log(`${colors.cyan}${colors.bright}SYSTEM TESTING${colors.reset}\n`);

  const tests = [
    ["Config file", fs.existsSync("user-config.json")],
    ["State file", fs.existsSync("state.json")],
    ["Lessons file", fs.existsSync("lessons.json")],
    ["Performance file", fs.existsSync("performance.json")],
    ["Environment variables", !!process.env.LLM_PROVIDER || fs.existsSync(".env")],
  ];

  console.log("Running tests...\n");

  tests.forEach(([test, passed]) => {
    console.log(`  ${passed ? colors.green : colors.red}${passed ? "✓" : "✗"}${colors.reset} ${test}`);
  });

  const allPassed = tests.every((t) => t[1]);
  console.log(
    `\n${allPassed ? colors.green : colors.red}${allPassed ? "✓ All tests passed!" : "⚠ Some tests failed"}${colors.reset}\n`
  );

  await question("Tekan Enter untuk kembali...");
}

async function documentationMenu() {
  clearScreen();
  console.log(`${colors.cyan}${colors.bright}DOCUMENTATION & HELP${colors.reset}\n`);

  const docs = [
    ["PONYOU-CLI-GUIDE.md", "Main CLI documentation"],
    ["LLM-CUSTOM-SETUP.md", "Custom LLM tools guide"],
    ["SETUP-PROVIDERS.md", "LLM provider setup"],
    ["SETUP.md", "Initial setup guide"],
  ];

  docs.forEach(([file, desc], i) => {
    const exists = fs.existsSync(file);
    console.log(
      `  ${exists ? colors.green : colors.red}${i + 1}${colors.reset}. ${file.padEnd(30)} ${colors.dim}${desc}${colors.reset}`
    );
  });

  console.log("");
  const choice = await question("Pilih file untuk dibuka (1-4) atau 'q' untuk kembali: ");

  if (choice !== "q" && choice !== "" && choice >= "1" && choice <= "4") {
    const fileIdx = parseInt(choice) - 1;
    const file = docs[fileIdx][0];
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      clearScreen();
      console.log(content);
      console.log("\n");
      await question("Tekan Enter untuk kembali...");
    }
  }
}

async function fileManagerMenu() {
  clearScreen();
  console.log(`${colors.cyan}${colors.bright}FILE MANAGER${colors.reset}\n`);

  const files = [
    { name: "user-config.json", desc: "Main configuration" },
    { name: ".env", desc: "Environment & secrets" },
    { name: "lessons.json", desc: "Learning data" },
    { name: "state.json", desc: "Agent state" },
    { name: "performance.json", desc: "Trade history" },
  ];

  files.forEach((f, i) => {
    const { name, desc } = f;
    const exists = fs.existsSync(name);
    const size = exists ? fs.statSync(name).size : 0;
    console.log(
      `  ${exists ? colors.green : colors.red}${i + 1}${colors.reset}. ${name.padEnd(25)} ${colors.dim}${desc} (${size} bytes)${colors.reset}`
    );
  });

  console.log("");
  const choice = await question("Pilih file untuk dilihat (1-5) atau 'q' untuk kembali: ");

  if (choice !== "q" && choice !== "" && choice >= "1" && choice <= "5") {
    const fileIdx = parseInt(choice) - 1;
    const file = files[fileIdx].name;
    if (fs.existsSync(file)) {
      clearScreen();
      const content = fs.readFileSync(file, "utf8");
      try {
        const json = JSON.parse(content);
        console.log(JSON.stringify(json, null, 2));
      } catch {
        console.log(content);
      }
      console.log("\n");
      await question("Tekan Enter untuk kembali...");
    }
  }
}

// Main
(async () => {
  try {
    await mainMenu();
  } catch (error) {
    console.error(`${colors.red}Error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
})();
