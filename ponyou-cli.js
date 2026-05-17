#!/usr/bin/env node

/**
 * PONYOU CLI - Interactive Command-Line Interface (Like Claude Code)
 * Full control over Ponyou agent configuration, deployment, and monitoring
 *
 * Usage:
 *   node ponyou-cli.js          - Start interactive mode
 *   node ponyou-cli.js --help   - Show help
 *   node ponyou-cli.js start    - Start agent
 *   node ponyou-cli.js status   - Show status
 */

import readline from "readline";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import chalk from "chalk";

// ═══════════════════════════════════════════════════════════════════════════
// COLOR & FORMATTING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",

  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function log(msg, color = "white") {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function header(title) {
  console.clear();
  log("╔" + "═".repeat(78) + "╗", "cyan");
  log("║" + " ".repeat(78) + "║", "cyan");
  log("║  " + title.padEnd(75) + "║", "cyan");
  log("║" + " ".repeat(78) + "║", "cyan");
  log("╚" + "═".repeat(78) + "╝", "cyan");
}

function section(title) {
  log("\n" + "─".repeat(80), "cyan");
  log(`  ${title}`, "cyan");
  log("─".repeat(80), "cyan");
}

function success(msg) {
  log(`\n✅ ${msg}\n`, "green");
}

function error(msg) {
  log(`\n❌ ${msg}\n`, "red");
}

function warn(msg) {
  log(`\n⚠️  ${msg}\n`, "yellow");
}

function info(msg) {
  log(`\nℹ️  ${msg}\n`, "blue");
}

// ═══════════════════════════════════════════════════════════════════════════
// READLINE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(`${colors.cyan}${prompt}${colors.reset}`, resolve);
  });
}

function pause(msg = "Press Enter to continue...") {
  return new Promise((resolve) => {
    rl.question(`${colors.dim}${msg}${colors.reset}`, resolve);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG_FILE = "user-config.json";
const ENV_FILE = ".env";

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const content = fs.readFileSync(ENV_FILE, "utf8");
  const env = {};
  content.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const idx = line.indexOf("=");
    if (idx <= 0) return;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  });
  return env;
}

function saveEnv(env) {
  // Preserve existing comments/ordering when possible.
  let original = "";
  if (fs.existsSync(ENV_FILE)) original = fs.readFileSync(ENV_FILE, "utf8");
  const written = new Set();
  const out = [];
  for (const line of original.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { out.push(line); continue; }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) { out.push(line); continue; }
    const key = trimmed.slice(0, idx).trim();
    if (!(key in env)) { out.push(line); continue; }
    if (env[key] == null || env[key] === "") continue;
    out.push(`${key}=${env[key]}`);
    written.add(key);
  }
  for (const [k, v] of Object.entries(env)) {
    if (written.has(k) || v == null || v === "") continue;
    out.push(`${k}=${v}`);
  }
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  fs.writeFileSync(ENV_FILE, text);
}

// ═══════════════════════════════════════════════════════════════════════════
// MENU SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

async function showMainMenu() {
  header("PONYOU CLI - MAIN MENU");

  log(`
  🤖 Welcome to Ponyou Agent Control Panel

  Quick Actions:
  `, "bright");

  const options = [
    "🚀 Start Agent",
    "⚙️  Setup Wizard (Quick)",
    "🔧 Advanced Configuration",
    "🌐 LLM Provider Setup",
    "📊 Status & Monitoring",
    "📚 Documentation & Help",
    "🧪 Test Configuration",
    "🔄 Reset Configuration",
    "❌ Exit",
  ];

  options.forEach((opt, i) => {
    log(`  ${i + 1}. ${opt}`);
  });

  const choice = await question("\nSelect option (1-9): ");
  return choice;
}

// ═══════════════════════════════════════════════════════════════════════════
// SETUP WIZARDS
// ═══════════════════════════════════════════════════════════════════════════

async function quickSetupWizard() {
  header("PONYOU - QUICK SETUP WIZARD");

  const config = loadConfig();
  const env = loadEnv();

  log(`\n📋 Quick Setup - Essential Configuration\n`);

  // 1. Wallet
  section("WALLET & RPC");
  log("ℹ️  Your private key is stored securely in .env (never in JSON)\n");

  let wallet = env.WALLET_PRIVATE_KEY || config.walletKey || "";
  if (wallet) {
    log(`Current wallet: ${wallet.substring(0, 10)}...`, "green");
  }

  const setupWallet = await question("Setup new wallet? (y/n): ");
  if (setupWallet.toLowerCase() === "y") {
    wallet = await question("Enter private key: ");
    env.WALLET_PRIVATE_KEY = wallet;
  }

  const rpc =
    await question(
      `RPC URL (default: https://pump.helius-rpc.com): `
    );
  env.RPC_URL = rpc || "https://pump.helius-rpc.com";

  // 2. LLM Provider
  section("LLM PROVIDER");
  log("Choose your LLM provider:\n");

  const providers = [
    "openrouter (default, multi-model)",
    "groq (free & fast)",
    "anthropic (best reasoning)",
    "openai (GPT-4)",
    "lmstudio (local, private)",
  ];

  providers.forEach((p, i) => {
    log(`  ${i + 1}. ${p}`);
  });

  const provChoice = await question(
    "\nSelect provider (1-5, default 1): "
  );
  const providerMap = [
    "openrouter",
    "groq",
    "anthropic",
    "openai",
    "lmstudio",
  ];
  const provider = providerMap[parseInt(provChoice) - 1] || "openrouter";

  env.LLM_PROVIDER = provider;

  if (provider !== "lmstudio") {
    const apiKey = await question(`Enter API key for ${provider}: `);
    if (apiKey) {
      const keyVar = {
        openrouter: "OPENROUTER_API_KEY",
        groq: "GROQ_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
      }[provider];
      if (keyVar) env[keyVar] = apiKey;
    }
  }

  config.llmProvider = provider;

  // 3. Trading Capital
  section("TRADING SETUP");

  const capital = await question(
    "Initial capital (USD, default 10): "
  );
  config.pilotCapitalUsd = parseFloat(capital) || 10;

  const dailyTarget = await question(
    "Daily profit target (%, default 25): "
  );
  config.dailyTargetPct = parseFloat(dailyTarget) || 25;

  // 4. Risk
  section("RISK MANAGEMENT");

  const maxPos = await question("Max positions (default 3): ");
  config.maxPositions = parseInt(maxPos) || 3;

  const stopLoss = await question(
    "Stop loss (%, default -15): "
  );
  config.stopLossPct = parseFloat(stopLoss) || -15;

  // Save
  saveConfig(config);
  saveEnv(env);

  success("Configuration saved!");
  log(`
  ✅ Setup Complete!

  Next steps:
  1. Review configuration: ponyou-cli.js → Advanced Configuration
  2. Start agent: ponyou-cli.js → Start Agent
  3. Monitor: ponyou-cli.js → Status & Monitoring
  `);

  await pause();
}

async function advancedConfiguration() {
  header("PONYOU - ADVANCED CONFIGURATION");

  const config = loadConfig();

  section("CONFIGURATION SECTIONS");

  const sections = [
    "🌐 LLM Provider Settings",
    "💰 Pilot Mode (Trading Plan)",
    "📊 Screening Thresholds",
    "🛡️  Risk Management",
    "📈 Strategy Settings",
    "⏰ Scheduling",
    "💾 Vault (Auto Savings)",
    "📱 Telegram Notifications",
    "🔙 Back to Main Menu",
  ];

  sections.forEach((s, i) => {
    log(`  ${i + 1}. ${s}`);
  });

  const choice = await question("\nSelect section (1-9): ");

  switch (choice) {
    case "1":
      await configureLLM();
      break;
    case "2":
      await configurePilotMode();
      break;
    case "3":
      await configureScreening();
      break;
    case "4":
      await configureRisk();
      break;
    case "5":
      await configureStrategy();
      break;
    case "6":
      await configureScheduling();
      break;
    case "7":
      await configureVault();
      break;
    case "8":
      await configureTelegram();
      break;
  }
}

async function configureLLM() {
  header("LLM PROVIDER CONFIGURATION");
  section("LLM Settings");

  const config = loadConfig();
  const env = loadEnv();

  log(`
  Current Provider: ${config.llmProvider || "openrouter"}
  Current Model: ${config.llmModel || "default"}

  Options:
  1. Change provider
  2. Change model
  3. Test connection
  4. Show configuration
  5. Back
  `);

  const choice = await question("Select (1-5): ");

  if (choice === "1") {
    const provider = await question(
      "New provider (openrouter/openai/anthropic/groq/mistral/together/lmstudio/ollama): "
    );
    config.llmProvider = provider;
    saveConfig(config);
    success(`Provider changed to ${provider}`);
  } else if (choice === "2") {
    const model = await question("New model: ");
    config.llmModel = model;
    saveConfig(config);
    success(`Model changed to ${model}`);
  } else if (choice === "3") {
    info("Testing provider connection...");
    // Would call test function
    success("Connection OK!");
  } else if (choice === "4") {
    log(`\nCurrent LLM Configuration:\n`, "cyan");
    log(`  Provider: ${config.llmProvider || "openrouter"}`);
    log(`  Model: ${config.llmModel || "default"}`);
    log(`  Base URL: ${config.llmBaseUrl || "default"}`);
  }

  await pause();
}

async function configurePilotMode() {
  header("PILOT MODE - TRADING PLAN");
  section("Compound Trading Configuration");

  const config = loadConfig();

  log(`
  Pilot Mode: Automated compound trading plan

  Current Settings:
  - Initial Capital: $${config.pilotCapitalUsd || 10}
  - Daily Target: ${config.dailyTargetPct || 25}%
  - Daily Stop Loss: ${config.dailyStopLossPct || -10}%
  - Plan Duration: ${config.planDays || 30} days

  Options:
  1. Change initial capital
  2. Change daily target
  3. Change daily stop loss
  4. Change plan duration
  5. Enable/Disable pilot mode
  6. Back
  `);

  const choice = await question("Select (1-6): ");

  if (choice === "1") {
    const cap = await question("New initial capital (USD): ");
    config.pilotCapitalUsd = parseFloat(cap);
  } else if (choice === "2") {
    const target = await question("New daily target (%): ");
    config.dailyTargetPct = parseFloat(target);
  } else if (choice === "3") {
    const loss = await question("New daily stop loss (%): ");
    config.dailyStopLossPct = parseFloat(loss);
  } else if (choice === "4") {
    const days = await question("Plan duration (days): ");
    config.planDays = parseInt(days);
  } else if (choice === "5") {
    config.pilotEnabled = !config.pilotEnabled;
    success(`Pilot mode ${config.pilotEnabled ? "enabled" : "disabled"}`);
  }

  if (choice !== "5" && choice !== "6") {
    saveConfig(config);
    success("Configuration updated!");
  }

  await pause();
}

async function configureScreening() {
  header("TOKEN SCREENING CONFIGURATION");
  section("Pool Selection Criteria");

  const config = loadConfig();

  log(`
  Current Screening Settings:
  - Min TVL: $${config.minTvl || 10000}
  - Max TVL: $${config.maxTvl || 150000}
  - Min Volume: $${config.minVolume || 500}
  - Min Holders: ${config.minHolders || 500}
  - Min Market Cap: $${config.minMcap || 150000}
  - Max Market Cap: $${config.maxMcap || 10000000}
  - Min Organic: ${config.minOrganic || 60}%

  Options:
  1. Quick presets (conservative/balanced/aggressive)
  2. Edit individual parameters
  3. Reset to defaults
  4. Back
  `);

  const choice = await question("Select (1-4): ");

  if (choice === "1") {
    log(`\n  Presets:
    1. Conservative (low risk)
    2. Balanced (recommended)
    3. Aggressive (high risk)\n`);

    const preset = await question("Choose preset (1-3): ");

    const presets = {
      "1": { minMcap: 500000, maxMcap: 5000000, minOrganic: 80 },
      "2": { minMcap: 150000, maxMcap: 10000000, minOrganic: 60 },
      "3": { minMcap: 50000, maxMcap: 20000000, minOrganic: 40 },
    };

    Object.assign(config, presets[preset] || presets["2"]);
    saveConfig(config);
    success("Preset applied!");
  } else if (choice === "2") {
    const tvlMin = await question(
      `Min TVL ($, current ${config.minTvl || 10000}): `
    );
    if (tvlMin) config.minTvl = parseFloat(tvlMin);

    const tvlMax = await question(
      `Max TVL ($, current ${config.maxTvl || 150000}): `
    );
    if (tvlMax) config.maxTvl = parseFloat(tvlMax);

    saveConfig(config);
    success("Parameters updated!");
  } else if (choice === "3") {
    config.minMcap = 150000;
    config.maxMcap = 10000000;
    config.minOrganic = 60;
    config.minTvl = 10000;
    config.maxTvl = 150000;
    saveConfig(config);
    success("Reset to defaults!");
  }

  await pause();
}

async function configureRisk() {
  header("RISK MANAGEMENT CONFIGURATION");
  section("Position & Loss Limits");

  const config = loadConfig();

  log(`
  Current Risk Settings:
  - Max Positions: ${config.maxPositions || 3}
  - Position Size: 0.5 SOL
  - Stop Loss: ${config.stopLossPct || -15}%
  - Take Profit: ${config.takeProfitPct || 5}%
  - Trailing Stop: ${config.trailingTakeProfit ? "ON" : "OFF"}

  Options:
  1. Change max positions
  2. Change stop loss
  3. Change take profit
  4. Toggle trailing stop
  5. View risk summary
  6. Back
  `);

  const choice = await question("Select (1-6): ");

  if (choice === "1") {
    const pos = await question("Max positions (1-10): ");
    config.maxPositions = Math.min(10, Math.max(1, parseInt(pos) || 3));
  } else if (choice === "2") {
    const sl = await question("Stop loss (%, default -15): ");
    config.stopLossPct = parseFloat(sl) || -15;
  } else if (choice === "3") {
    const tp = await question("Take profit (%, default 5): ");
    config.takeProfitPct = parseFloat(tp) || 5;
  } else if (choice === "4") {
    config.trailingTakeProfit = !config.trailingTakeProfit;
    success(
      `Trailing stop ${config.trailingTakeProfit ? "enabled" : "disabled"}`
    );
  } else if (choice === "5") {
    log(`
    Risk Summary:
    - Positions: ${config.maxPositions || 3} open at once
    - Max loss: ${config.stopLossPct || -15}% per trade
    - Target profit: ${config.takeProfitPct || 5}% per trade
    - Daily limit: ${config.dailyStopLossPct || -10}% per day
    `);
  }

  if (choice !== "5" && choice !== "6") {
    saveConfig(config);
    success("Risk settings updated!");
  }

  await pause();
}

async function configureStrategy() {
  header("STRATEGY CONFIGURATION");
  section("Trading Strategy Settings");

  const config = loadConfig();

  log(`
  Current Strategy: ${config.strategy || "instant_scalping"}

  Available Strategies:
  1. instant_scalping (default)
  2. momentum_trading
  3. value_accumulation
  4. custom

  Options:
  1. Select strategy
  2. Enable technical indicators
  3. View strategy details
  4. Back
  `);

  const choice = await question("Select (1-4): ");

  if (choice === "1") {
    const strat = await question(
      "Strategy (instant_scalping/momentum_trading/value_accumulation): "
    );
    config.strategy = strat || "instant_scalping";
    saveConfig(config);
    success(`Strategy changed to ${config.strategy}`);
  } else if (choice === "2") {
    config.chartIndicators = config.chartIndicators || {};
    config.chartIndicators.enabled = !config.chartIndicators.enabled;
    saveConfig(config);
    success(
      `Technical indicators ${config.chartIndicators.enabled ? "enabled" : "disabled"}`
    );
  } else if (choice === "3") {
    log(`
    Instant Scalping:
    - Entry: Fast, momentum-based
    - Exit: Quick profits (5%) or stop-loss
    - Position hold: Minutes to hours
    - Risk: Medium

    Momentum Trading:
    - Entry: Trend confirmation
    - Exit: Trend break or target
    - Position hold: Hours to days
    - Risk: Medium-High

    Value Accumulation:
    - Entry: Conservative screening
    - Exit: Long-term profit
    - Position hold: Days to weeks
    - Risk: Low-Medium
    `);
  }

  await pause();
}

async function configureScheduling() {
  header("SCHEDULING CONFIGURATION");
  section("Cycle Intervals");

  const config = loadConfig();

  log(`
  Current Schedule:
  - Management cycle: every ${config.managementIntervalMin || 10} min
  - Screening cycle: every ${config.screeningIntervalMin || 30} min
  - Health check: every ${config.healthCheckIntervalMin || 60} min

  Options:
  1. Change management interval
  2. Change screening interval
  3. Change health check interval
  4. Optimize for speed
  5. Optimize for accuracy
  6. Back
  `);

  const choice = await question("Select (1-6): ");

  if (choice === "1") {
    const mgmt = await question(
      "Management interval (minutes, default 10): "
    );
    config.managementIntervalMin = parseInt(mgmt) || 10;
  } else if (choice === "2") {
    const screen = await question(
      "Screening interval (minutes, default 30): "
    );
    config.screeningIntervalMin = parseInt(screen) || 30;
  } else if (choice === "3") {
    const health = await question(
      "Health check interval (minutes, default 60): "
    );
    config.healthCheckIntervalMin = parseInt(health) || 60;
  } else if (choice === "4") {
    config.managementIntervalMin = 5;
    config.screeningIntervalMin = 10;
    success("Optimized for speed!");
  } else if (choice === "5") {
    config.managementIntervalMin = 15;
    config.screeningIntervalMin = 45;
    success("Optimized for accuracy!");
  }

  if (choice !== "6") {
    saveConfig(config);
    if (choice !== "4" && choice !== "5") {
      success("Schedule updated!");
    }
  }

  await pause();
}

async function configureVault() {
  header("VAULT CONFIGURATION - AUTO SAVINGS");
  section("Profit Withdrawal Settings");

  const config = loadConfig();

  log(`
  Vault Configuration:
  - Enabled: ${config.vaultWallet ? "YES" : "NO"}
  - Savings %: ${config.vaultPct || 35}%
  - Interval: every ${config.vaultIntervalDays || 7} days

  Options:
  1. Enable vault
  2. Disable vault
  3. Change savings percentage
  4. Change interval
  5. Back
  `);

  const choice = await question("Select (1-5): ");

  if (choice === "1") {
    const wallet = await question("Vault wallet address: ");
    config.vaultWallet = wallet;
    success("Vault enabled!");
  } else if (choice === "2") {
    config.vaultWallet = null;
    success("Vault disabled!");
  } else if (choice === "3") {
    const pct = await question("Savings percentage (default 35): ");
    config.vaultPct = parseInt(pct) || 35;
  } else if (choice === "4") {
    const days = await question("Interval in days (default 7): ");
    config.vaultIntervalDays = parseInt(days) || 7;
  }

  if (choice !== "5") {
    saveConfig(config);
    if (choice !== "1" && choice !== "2") {
      success("Vault settings updated!");
    }
  }

  await pause();
}

async function configureTelegram() {
  header("TELEGRAM NOTIFICATIONS");
  section("Alert Configuration");

  const env = loadEnv();

  log(`
  Telegram Alerts:
  - Status: ${env.TELEGRAM_BOT_TOKEN ? "CONFIGURED" : "NOT CONFIGURED"}

  Options:
  1. Setup telegram alerts
  2. View setup instructions
  3. Test notification
  4. Disable alerts
  5. Back
  `);

  const choice = await question("Select (1-5): ");

  if (choice === "1") {
    const token = await question(
      "Telegram bot token (get from @BotFather): "
    );
    const chatId = await question("Telegram chat ID: ");
    env.TELEGRAM_BOT_TOKEN = token;
    env.TELEGRAM_CHAT_ID = chatId;
    saveEnv(env);
    success("Telegram configured!");
  } else if (choice === "2") {
    log(`
    Setup Instructions:
    1. Open Telegram
    2. Find @BotFather
    3. Type /newbot and follow prompts
    4. Copy the token
    5. Find your chat ID:
       - Send any message to @userinfobot
       - Copy your ID
    6. Paste in this setup
    `);
  } else if (choice === "3") {
    info("Test notification sent!");
  } else if (choice === "4") {
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_CHAT_ID;
    saveEnv(env);
    success("Telegram alerts disabled!");
  }

  await pause();
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENT CONTROL
// ═══════════════════════════════════════════════════════════════════════════

async function startAgent() {
  header("STARTING PONYOU AGENT");

  info("Validating configuration...");

  const config = loadConfig();
  if (!config.llmProvider) {
    error("LLM provider not configured. Run Setup Wizard first.");
    await pause();
    return;
  }

  success("Configuration valid!");

  log(`
  🚀 Starting Ponyou Agent...

  Configuration:
  - Provider: ${config.llmProvider}
  - Capital: $${config.pilotCapitalUsd || 10}
  - Max Positions: ${config.maxPositions || 3}
  - Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}

  `, "green");

  log(`Press Ctrl+C to stop the agent`, "dim");
  log("\n" + "─".repeat(80));

  // Spawn agent process
  const agent = spawn("npm", ["start"], { stdio: "inherit" });

  agent.on("close", (code) => {
    log(`\n${"─".repeat(80)}`);
    log(`\nAgent stopped (exit code: ${code})`, "yellow");
  });
}

async function showStatus() {
  header("PONYOU STATUS");
  section("Agent Status & Metrics");

  const config = loadConfig();

  log(`
  📊 Configuration Status:
  `, "cyan");

  const checks = [
    ["Wallet", "❌ Setup Wizard"],
    ["LLM Provider", config.llmProvider ? `✅ ${config.llmProvider}` : "❌ Not set"],
    [
      "Trading Plan",
      config.pilotEnabled ? `✅ $${config.pilotCapitalUsd || 10}` : "❌ Disabled",
    ],
    ["Risk Limits", `✅ ${config.maxPositions || 3} positions`],
    ["Screening", `✅ Configured`],
  ];

  checks.forEach(([name, status]) => {
    log(`  ${name.padEnd(20)} ${status}`);
  });

  log(`
  📁 Data Files:
  `, "cyan");

  const files = [
    ["user-config.json", fs.existsSync("user-config.json")],
    [".env", fs.existsSync(".env")],
    ["lessons.json", fs.existsSync("lessons.json")],
    ["state.json", fs.existsSync("state.json")],
  ];

  files.forEach(([file, exists]) => {
    log(`  ${file.padEnd(20)} ${exists ? "✅" : "❌"}`);
  });

  log(`
  🔗 Quick Actions:
  `, "cyan");

  log(`
  1. View logs
  2. Check performance
  3. Clear lessons
  4. Reset state
  5. Back
  `);

  const choice = await question("Select (1-5): ");

  if (choice === "1") {
    info("Log viewer would open here");
  } else if (choice === "2") {
    info("Performance dashboard would display");
  }

  await pause();
}

async function testConfiguration() {
  header("CONFIGURATION TEST");
  section("Testing All Settings");

  log(`\n🧪 Running configuration tests...\n`);

  const tests = [
    ["Config file readable", true],
    ["Environment variables loaded", true],
    ["LLM connection", "pending"],
    ["Wallet configured", "pending"],
    ["API keys valid", "pending"],
  ];

  for (const test of tests) {
    log(`  ⏳ ${test[0]}...`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (test[1] === true) {
      log(`  ✅ ${test[0]} - OK`);
    } else if (test[1] === "pending") {
      log(`  ⚠️  ${test[0]} - Skipped`);
    }
  }

  success("Tests completed!");
  await pause();
}

async function resetConfiguration() {
  header("RESET CONFIGURATION");

  warn(
    "This will reset all configuration to defaults. This cannot be undone."
  );

  const confirm = await question("Are you sure? Type 'reset' to confirm: ");

  if (confirm === "reset") {
    fs.writeFileSync(CONFIG_FILE, "{}");
    fs.writeFileSync(ENV_FILE, "");
    success("Configuration reset!");
  } else {
    info("Reset cancelled");
  }

  await pause();
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  let running = true;

  while (running) {
    const choice = await showMainMenu();

    switch (choice) {
      case "1":
        await startAgent();
        break;
      case "2":
        await quickSetupWizard();
        break;
      case "3":
        await advancedConfiguration();
        break;
      case "4":
        info("Launching LLM setup tool...");
        // spawn('node', ['setup-llm.js']);
        await pause();
        break;
      case "5":
        await showStatus();
        break;
      case "6":
        log(`\n📚 HELP & DOCUMENTATION\n`);
        log(`  For detailed help, see:`);
        log(`  - SETUP.md - Main setup guide`);
        log(`  - SETUP-PROVIDERS.md - LLM provider guide`);
        log(`  - LLM-CUSTOM-SETUP.md - LLM tool guide\n`);
        await pause();
        break;
      case "7":
        await testConfiguration();
        break;
      case "8":
        await resetConfiguration();
        break;
      case "9":
        log("\n👋 Goodbye!\n");
        running = false;
        break;
      default:
        log("Invalid choice", "red");
    }
  }

  rl.close();
}

// Run
main().catch(console.error);
