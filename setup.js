#!/usr/bin/env node
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { validateWalletTopology } from "./wallet-topology.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "user-config.json");
const ENV_PATH = path.join(__dirname, ".env");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

function prompt(msg, defaultVal = "") {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return question(`${msg}${suffix}: `);
}

async function promptYesNo(msg, defaultVal = true) {
  const def = defaultVal ? "Y/n" : "y/N";
  const answer = await question(`${msg} [${def}]: `);
  if (answer === "") return defaultVal;
  return answer.toLowerCase().startsWith("y");
}

async function promptNumber(msg, defaultVal) {
  const defStr = defaultVal !== undefined ? ` [${defaultVal}]` : "";
  const answer = await question(`${msg}${defStr}: `);
  if (answer === "") return defaultVal;
  const num = parseFloat(answer);
  return isNaN(num) ? defaultVal : num;
}

async function promptSelect(msg, options) {
  console.log(`\n${msg}:`);
  options.forEach((opt, i) => {
    console.log(`  ${i + 1}. ${opt}`);
  });
  let choice = await question("Select (1-" + options.length + "): ");
  choice = parseInt(choice) - 1;
  return choice >= 0 && choice < options.length ? options[choice] : options[0];
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, "utf8");
    content.split("\n").forEach((line) => {
      line = line.trim();
      if (!line || line.startsWith("#")) return;
      const [key, ...valParts] = line.split("=");
      if (key) env[key.trim()] = valParts.join("=").trim();
    });
  }
  return env;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`✓ Konfigurasi disimpan ke ${CONFIG_PATH}`);
}

function saveEnv(env) {
  const lines = [
    "# ── Wallet ────────────────────────────────────────────────────────────────────",
    `WALLET_PRIVATE_KEY=${env.WALLET_PRIVATE_KEY || ""}`,
    "",
    "# ── Solana RPC ─────────────────────────────────────────────────────────────────",
    `RPC_URL=${env.RPC_URL || ""}`,
    "",
    "# ── LLM Provider ──────────────────────────────────────────────────────────────",
    "# Option A: OpenRouter (default)",
    `OPENROUTER_API_KEY=${env.OPENROUTER_API_KEY || ""}`,
    "",
    "# Option B: LM Studio (local)",
    `LLM_BASE_URL=${env.LLM_BASE_URL || ""}`,
    `LLM_API_KEY=${env.LLM_API_KEY || ""}`,
    `LLM_MODEL=${env.LLM_MODEL || ""}`,
    "",
    "# ── API Keys ───────────────────────────────────────────────────────────────────",
    `HELIUS_API_KEY=${env.HELIUS_API_KEY || ""}`,
    `GMGN_ROUTE_KEY=${env.GMGN_ROUTE_KEY || ""}`,
    "",
    "# ── Telegram Notifications ─────────────────────────────────────────────────────",
    `TELEGRAM_BOT_TOKEN=${env.TELEGRAM_BOT_TOKEN || ""}`,
    `TELEGRAM_CHAT_ID=${env.TELEGRAM_CHAT_ID || ""}`,
    `TELEGRAM_ALLOWED_USER_IDS=${env.TELEGRAM_ALLOWED_USER_IDS || ""}`,
    "",
    "# ── Vault / Tabungan ──────────────────────────────────────────────────────────",
    `VAULT_WALLET=${env.VAULT_WALLET || ""}`,
    "",
    "# ── Misc ──────────────────────────────────────────────────────────────────────",
    `DRY_RUN=${env.DRY_RUN || "false"}`,
    `LOG_LEVEL=${env.LOG_LEVEL || "info"}`,
  ];
  fs.writeFileSync(ENV_PATH, lines.join("\n"));
  console.log(`✓ Environment disimpan ke ${ENV_PATH}`);
}

async function setupWalletAndRpc(cfg, env) {
  console.log("\n━━━ WALLET & RPC ━━━");
  cfg.walletKey =
    (await prompt("Wallet Private Key (base58)", cfg.walletKey)) ||
    cfg.walletKey;
  cfg.rpcUrl = (await prompt("RPC URL", cfg.rpcUrl || "https://pump.helius-rpc.com")) || cfg.rpcUrl;

  env.WALLET_PRIVATE_KEY = cfg.walletKey;
  env.RPC_URL = cfg.rpcUrl;
}

async function setupMultiWallet(cfg) {
  console.log("\n━━━ MULTI-WALLET ━━━");
  cfg.multiWalletEnabled = await promptYesNo(
    "Aktifkan multi-wallet?",
    cfg.multiWalletEnabled
  );

  if (!cfg.multiWalletEnabled) {
    console.log("Multi-wallet dimatikan. Daftar wallets yang tersimpan tidak dihapus.");
    return;
  }

  const existingWallets = Array.isArray(cfg.wallets) ? cfg.wallets : [];
  const editWallets = await promptYesNo(
    "Atur daftar wallet multi-wallet sekarang?",
    existingWallets.length > 0 ? false : true
  );

  if (editWallets) {
    const walletCount = Math.max(0, Math.floor(await promptNumber(
      "Jumlah wallet multi-wallet",
      existingWallets.length || 2
    )));
    const wallets = [];

    for (let i = 0; i < walletCount; i++) {
      const current = existingWallets[i] || {};
      console.log("\nWallet #" + (i + 1));
      const label = (await prompt(
        "Label wallet",
        current.label || ("wallet-" + (i + 1))
      )) || current.label || ("wallet-" + (i + 1));
      const key = (await prompt(
        "Private key wallet (base58)",
        current.key || ""
      )) || current.key || "";
      const capitalPct = await promptNumber(
        "Capital allocation (%)",
        current.capital_pct || (walletCount > 0 ? Math.floor(100 / walletCount) : 100)
      );

      if (key) {
        wallets.push({
          label,
          key,
          capital_pct: capitalPct,
        });
      }
    }

    cfg.wallets = wallets;
  } else if (!Array.isArray(cfg.wallets)) {
    cfg.wallets = existingWallets;
  }

  cfg.multiWalletMaxErrors = await promptNumber(
    "Max error sebelum rotasi wallet",
    cfg.multiWalletMaxErrors || 3
  );
  cfg.multiWalletCooldownMin = await promptNumber(
    "Cooldown wallet error (menit)",
    cfg.multiWalletCooldownMin || 10
  );
  cfg.multiWalletAutoSpreadEnabled = await promptYesNo(
    "Aktifkan auto spread antar wallet?",
    cfg.multiWalletAutoSpreadEnabled !== false
  );
  cfg.multiWalletAutoSpreadMinTotalSol = await promptNumber(
    "Min total SOL untuk auto spread",
    cfg.multiWalletAutoSpreadMinTotalSol || 3
  );
  cfg.multiWalletMinWalletDeploySol = await promptNumber(
    "Min deploy SOL per wallet",
    cfg.multiWalletMinWalletDeploySol || 0.25
  );
  cfg.multiWalletMaxWalletsPerBatch = await promptNumber(
    "Max wallet per batch",
    cfg.multiWalletMaxWalletsPerBatch || 2
  );

  const totalPct = (Array.isArray(cfg.wallets) ? cfg.wallets : []).reduce(
    (sum, wallet) => sum + (Number(wallet.capital_pct) || 0),
    0
  );
  const topology = validateWalletTopology({ enabled: !!cfg.multiWalletEnabled, wallets: cfg.wallets || [] });

  if (cfg.wallets?.length) {
    console.log("Total capital allocation: " + totalPct + "%");
    if (!topology.ok) {
      throw new Error(`Multi-wallet topology invalid: ${topology.errors.join(" ")}`);
    }
  } else if (cfg.multiWalletEnabled) {
    throw new Error("Multi-wallet aktif tapi belum ada wallet di wallets[].");
  }
}

async function setupLlm(cfg, env) {
  console.log("\n━━━ LLM PROVIDER ━━━");
  const provider = await promptSelect("Pilih LLM provider", [
    "OpenRouter (default)",
    "LM Studio (local)",
  ]);

  if (provider === "OpenRouter (default)") {
    env.OPENROUTER_API_KEY = await prompt(
      "OpenRouter API Key",
      env.OPENROUTER_API_KEY
    );
    cfg.llmModel =
      (await prompt("Model (default: minimax/minimax-m2.7)", cfg.llmModel)) ||
      cfg.llmModel ||
      "minimax/minimax-m2.7";
    env.LLM_BASE_URL = "";
    env.LLM_API_KEY = "";
  } else {
    env.LLM_BASE_URL = await prompt(
      "LM Studio Base URL",
      env.LLM_BASE_URL || "http://localhost:1234/v1"
    );
    env.LLM_API_KEY = await prompt("LM Studio API Key", env.LLM_API_KEY || "lm-studio");
    cfg.llmModel = await prompt("Model name", cfg.llmModel);
    env.OPENROUTER_API_KEY = "";
  }
}

async function setupPilot(cfg) {
  console.log("\n━━━ PILOT: COMPOUND TRADING PLAN (30 HARI) ━━━");
  cfg.pilotEnabled = await promptYesNo("Aktifkan pilot mode?", cfg.pilotEnabled);

  if (cfg.pilotEnabled) {
    cfg.pilotCapitalUsd = await promptNumber(
      "Modal awal (USD)",
      cfg.pilotCapitalUsd || 10
    );
    cfg.dailyTargetPct = await promptNumber(
      "Target profit harian (%)",
      cfg.dailyTargetPct || 25
    );
    cfg.dailyStopLossPct = await promptNumber(
      "Stop loss harian (%)",
      cfg.dailyStopLossPct || -10
    );
    cfg.sessionPauseDurationMin = await promptNumber(
      "Pause duration saat target/loss tercapai (menit)",
      cfg.sessionPauseDurationMin || 60
    );
    cfg.learningModeDurationMin = await promptNumber(
      "Learning mode duration (menit)",
      cfg.learningModeDurationMin || 60
    );
    cfg.planDays = await promptNumber(
      "Durasi plan (hari)",
      cfg.planDays || 30
    );
    cfg.autoAdaptToMarket = await promptYesNo(
      "Auto adapt ke market conditions?",
      cfg.autoAdaptToMarket !== false
    );
  }
}

async function setupVault(cfg) {
  console.log("\n━━━ VAULT: TABUNGAN OTOMATIS ━━━");
  cfg.vaultWallet = await prompt("Vault wallet address", cfg.vaultWallet);
  if (cfg.vaultWallet) {
    cfg.vaultPct = await promptNumber(
      "Persentase profit untuk vault (%)",
      cfg.vaultPct || 35
    );
    cfg.vaultIntervalDays = await promptNumber(
      "Interval transfer (hari)",
      cfg.vaultIntervalDays || 7
    );
  }
}

async function setupReport(cfg) {
  console.log("\n━━━ LAPORAN HARIAN ━━━");
  cfg.dailyReportEnabled = await promptYesNo(
    "Aktifkan laporan harian?",
    cfg.dailyReportEnabled !== false
  );
  if (cfg.dailyReportEnabled) {
    cfg.dailyReportHourUtc = await promptNumber(
      "Jam UTC trigger report",
      cfg.dailyReportHourUtc || 0
    );
    cfg.dailyReportMinuteUtc = await promptNumber(
      "Menit trigger report",
      cfg.dailyReportMinuteUtc || 5
    );
  }
}

async function setupRisk(cfg) {
  console.log("\n━━━ RISK LIMITS ━━━");
  cfg.maxPositions = await promptNumber(
    "Max posisi terbuka",
    cfg.maxPositions || 3
  );
  cfg.maxDeployAmount = await promptNumber(
    "Max deploy amount (USD)",
    cfg.maxDeployAmount || 50
  );
}

async function setupScreening(cfg) {
  console.log("\n━━━ SCREENING: POOL SELECTION ━━━");
  cfg.minTvl = await promptNumber(
    "Min TVL",
    cfg.minTvl || 10000
  );
  cfg.maxTvl = await promptNumber(
    "Max TVL",
    cfg.maxTvl || 150000
  );
  cfg.minVolume = await promptNumber(
    "Min volume (24h)",
    cfg.minVolume || 500
  );
  cfg.minOrganic = await promptNumber(
    "Min organic pct",
    cfg.minOrganic || 60
  );
  cfg.minHolders = await promptNumber(
    "Min holders",
    cfg.minHolders || 500
  );
  cfg.minMcap = await promptNumber(
    "Min market cap",
    cfg.minMcap || 150000
  );
  cfg.maxMcap = await promptNumber(
    "Max market cap",
    cfg.maxMcap || 10000000
  );
  cfg.timeframe = await prompt(
    "Timeframe",
    cfg.timeframe || "5m"
  );
  cfg.category = await prompt(
    "Category",
    cfg.category || "trending"
  );

  cfg.excludeHighSupplyConcentration = await promptYesNo(
    "Exclude high supply concentration?",
    cfg.excludeHighSupplyConcentration !== false
  );
  cfg.useDiscordSignals = await promptYesNo(
    "Gunakan Discord signals?",
    cfg.useDiscordSignals
  );
  if (cfg.useDiscordSignals) {
    cfg.discordSignalMode = await promptSelect(
      "Discord signal mode",
      ["merge", "only"]
    );
  }

  cfg.avoidPvpSymbols = await promptYesNo(
    "Avoid PVP symbols?",
    cfg.avoidPvpSymbols !== false
  );
  cfg.blockPvpSymbols = await promptYesNo(
    "Block PVP symbols (hard filter)?",
    cfg.blockPvpSymbols
  );

  cfg.maxBundlePct = await promptNumber(
    "Max bundle %",
    cfg.maxBundlePct || 30
  );
  cfg.maxBotHoldersPct = await promptNumber(
    "Max bot holders %",
    cfg.maxBotHoldersPct || 30
  );
  cfg.maxTop10Pct = await promptNumber(
    "Max top 10 holders %",
    cfg.maxTop10Pct || 60
  );

  cfg.minTokenFeesSol = await promptNumber(
    "Min token fees (SOL)",
    cfg.minTokenFeesSol || 30
  );
}

async function setupManagement(cfg) {
  console.log("\n━━━ POSITION MANAGEMENT ━━━");
  cfg.deployAmountSol = await promptNumber(
    "Deploy amount (SOL)",
    cfg.deployAmountSol || 0.5
  );
  cfg.minSolToOpen = await promptNumber(
    "Min SOL to open position",
    cfg.minSolToOpen || 0.55
  );
  cfg.gasReserve = await promptNumber(
    "Gas reserve (SOL)",
    cfg.gasReserve || 0.2
  );
  cfg.positionSizePct = await promptNumber(
    "Position size %",
    cfg.positionSizePct || 0.35
  );

  cfg.stopLossPct = await promptNumber(
    "Stop loss %",
    cfg.stopLossPct || -50
  );
  cfg.takeProfitPct = await promptNumber(
    "Take profit %",
    cfg.takeProfitPct || 5
  );

  cfg.trailingTakeProfit = await promptYesNo(
    "Aktifkan trailing take profit?",
    cfg.trailingTakeProfit !== false
  );
  if (cfg.trailingTakeProfit) {
    cfg.trailingTriggerPct = await promptNumber(
      "Trailing trigger %",
      cfg.trailingTriggerPct || 3
    );
    cfg.trailingDropPct = await promptNumber(
      "Trailing drop %",
      cfg.trailingDropPct || 1.5
    );
  }

  cfg.minClaimAmount = await promptNumber(
    "Min claim amount",
    cfg.minClaimAmount || 5
  );
  cfg.autoSwapAfterClaim = await promptYesNo(
    "Auto swap after claim?",
    cfg.autoSwapAfterClaim
  );

  cfg.minVolumeToRebalance = await promptNumber(
    "Min volume to rebalance",
    cfg.minVolumeToRebalance || 1000
  );
  cfg.minFeePerTvl24h = await promptNumber(
    "Min fee per TVL (24h)",
    cfg.minFeePerTvl24h || 7
  );
}

async function setupScheduling(cfg) {
  console.log("\n━━━ SCHEDULING ━━━");
  cfg.managementIntervalMin = await promptNumber(
    "Management interval (menit)",
    cfg.managementIntervalMin || 10
  );
  cfg.screeningIntervalMin = await promptNumber(
    "Screening interval (menit)",
    cfg.screeningIntervalMin || 30
  );
  cfg.healthCheckIntervalMin = await promptNumber(
    "Health check interval (menit)",
    cfg.healthCheckIntervalMin || 60
  );
}

async function setupLlmSettings(cfg) {
  console.log("\n━━━ LLM SETTINGS ━━━");
  cfg.temperature = await promptNumber(
    "Temperature",
    cfg.temperature || 0.373
  );
  cfg.maxTokens = await promptNumber(
    "Max tokens",
    cfg.maxTokens || 4096
  );
  cfg.maxSteps = await promptNumber(
    "Max steps",
    cfg.maxSteps || 20
  );
}

async function setupDarwin(cfg) {
  console.log("\n━━━ DARWINIAN SIGNAL WEIGHTING ━━━");
  cfg.darwinEnabled = await promptYesNo(
    "Aktifkan darwin weighting?",
    cfg.darwinEnabled !== false
  );
  if (cfg.darwinEnabled) {
    cfg.darwinWindowDays = await promptNumber(
      "Window (hari)",
      cfg.darwinWindowDays || 60
    );
    cfg.darwinRecalcEvery = await promptNumber(
      "Recalc every (closes)",
      cfg.darwinRecalcEvery || 5
    );
    cfg.darwinBoost = await promptNumber(
      "Boost factor",
      cfg.darwinBoost || 1.05
    );
    cfg.darwinDecay = await promptNumber(
      "Decay factor",
      cfg.darwinDecay || 0.95
    );
    cfg.darwinFloor = await promptNumber(
      "Weight floor",
      cfg.darwinFloor || 0.3
    );
    cfg.darwinCeiling = await promptNumber(
      "Weight ceiling",
      cfg.darwinCeiling || 2.5
    );
  }
}

async function setupIndicators(cfg) {
  console.log("\n━━━ CHART INDICATORS ━━━");
  if (!cfg.chartIndicators) cfg.chartIndicators = {};

  cfg.chartIndicators.enabled = await promptYesNo(
    "Aktifkan indicators?",
    cfg.chartIndicators.enabled
  );

  if (cfg.chartIndicators.enabled) {
    cfg.chartIndicators.entryPreset = await prompt(
      "Entry preset",
      cfg.chartIndicators.entryPreset || "supertrend_break"
    );
    cfg.chartIndicators.exitPreset = await prompt(
      "Exit preset",
      cfg.chartIndicators.exitPreset || "supertrend_break"
    );
    cfg.chartIndicators.rsiLength = await promptNumber(
      "RSI length",
      cfg.chartIndicators.rsiLength || 2
    );
    cfg.chartIndicators.candles = await promptNumber(
      "Candles count",
      cfg.chartIndicators.candles || 298
    );
  }
}

async function setupTelegram(env) {
  console.log("\n━━━ TELEGRAM NOTIFICATIONS ━━━");
  const enable = await promptYesNo("Setup Telegram?", false);
  if (enable) {
    env.TELEGRAM_BOT_TOKEN = await prompt(
      "Bot token",
      env.TELEGRAM_BOT_TOKEN
    );
    env.TELEGRAM_CHAT_ID = await prompt(
      "Chat ID",
      env.TELEGRAM_CHAT_ID
    );
    env.TELEGRAM_ALLOWED_USER_IDS = await prompt(
      "Allowed user IDs (comma-separated)",
      env.TELEGRAM_ALLOWED_USER_IDS
    );
  }
}

async function setupHivemind(cfg) {
  console.log("\n━━━ HIVEMIND / AGENT MERIDIAN ━━━");
  cfg.hiveMindUrl = await prompt(
    "HiveMind URL",
    cfg.hiveMindUrl || "https://api.agentmeridian.xyz"
  );
  cfg.hiveMindApiKey = await prompt(
    "HiveMind API Key",
    cfg.hiveMindApiKey
  );
  cfg.agentId = await prompt(
    "Agent ID",
    cfg.agentId
  );
  cfg.publicApiKey = await prompt(
    "Public API Key",
    cfg.publicApiKey
  );
  cfg.agentMeridianApiUrl = await prompt(
    "Agent Meridian API URL",
    cfg.agentMeridianApiUrl || "https://api.agentmeridian.xyz/api"
  );
}

async function setupAdvanced(cfg, env) {
  console.log("\n━━━ ADVANCED ━━━");
  const showAdvanced = await promptYesNo("Show advanced settings?", false);
  if (!showAdvanced) return;

  cfg.solMode = await promptYesNo(
    "Enable SOL mode (report in SOL)?",
    cfg.solMode
  );
  cfg.dryRun = await promptYesNo(
    "Enable dry run?",
    cfg.dryRun
  );
  env.DRY_RUN = String(cfg.dryRun);

  cfg.repeatDeployCooldownEnabled = await promptYesNo(
    "Repeat deploy cooldown?",
    cfg.repeatDeployCooldownEnabled !== false
  );
  if (cfg.repeatDeployCooldownEnabled) {
    cfg.repeatDeployCooldownTriggerCount = await promptNumber(
      "Cooldown trigger count",
      cfg.repeatDeployCooldownTriggerCount || 3
    );
    cfg.repeatDeployCooldownHours = await promptNumber(
      "Cooldown hours",
      cfg.repeatDeployCooldownHours || 12
    );
  }

  const allowLaunchpads = await prompt(
    "Allowed launchpads (comma-separated, leave empty for none)",
    cfg.allowedLaunchpads?.join(",") || ""
  );
  cfg.allowedLaunchpads = allowLaunchpads
    ? allowLaunchpads.split(",").map((x) => x.trim())
    : [];

  const blockedLaunchpads = await prompt(
    "Blocked launchpads (comma-separated, leave empty for none)",
    cfg.blockedLaunchpads?.join(",") || ""
  );
  cfg.blockedLaunchpads = blockedLaunchpads
    ? blockedLaunchpads.split(",").map((x) => x.trim())
    : [];

  cfg.lpAgentRelayEnabled = await promptYesNo(
    "Enable LP agent relay?",
    cfg.lpAgentRelayEnabled
  );
}

async function viewCurrentConfig() {
  const cfg = loadConfig();
  console.log("\n━━━ CURRENT CONFIGURATION ━━━\n");
  console.log(JSON.stringify(cfg, null, 2));
}

async function resetConfig() {
  const confirm = await promptYesNo(
    "\n⚠️  Ini akan menghapus user-config.json. Lanjutkan?",
    false
  );
  if (confirm) {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
      console.log("✓ user-config.json dihapus");
    }
  }
}

async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║       PONYOU SETUP WIZARD v2.0         ║");
  console.log("║    Interactive Configuration Tool      ║");
  console.log("╚════════════════════════════════════════╝\n");

  while (true) {
    console.log("\n┌─ MAIN MENU ─────────────────────────────┐");
    console.log("│  1. Full Setup (wizard interaktif)     │");
    console.log("│  2. Quick Setup (essentials only)      │");
    console.log("│  3. View Current Config                │");
    console.log("│  4. Reset Config                       │");
    console.log("│  5. Exit                               │");
    console.log("└─────────────────────────────────────────┘");

    const choice = await prompt("\nPilih menu");

    if (choice === "1") {
      const cfg = loadConfig();
      const env = loadEnv();

      await setupWalletAndRpc(cfg, env);
      await setupMultiWallet(cfg);
      await setupLlm(cfg, env);
      await setupPilot(cfg);
      await setupVault(cfg);
      await setupReport(cfg);
      await setupRisk(cfg);
      await setupScreening(cfg);
      await setupManagement(cfg);
      await setupScheduling(cfg);
      await setupLlmSettings(cfg);
      await setupDarwin(cfg);
      await setupIndicators(cfg);
      await setupTelegram(env);
      await setupHivemind(cfg);
      await setupAdvanced(cfg, env);

      saveConfig(cfg);
      saveEnv(env);
      console.log("\n✓ Setup lengkap!");
    } else if (choice === "2") {
      const cfg = loadConfig();
      const env = loadEnv();

      await setupWalletAndRpc(cfg, env);
      await setupMultiWallet(cfg);
      await setupLlm(cfg, env);
      await setupPilot(cfg);
      await setupRisk(cfg);

      saveConfig(cfg);
      saveEnv(env);
      console.log("\n✓ Quick setup selesai!");
    } else if (choice === "3") {
      await viewCurrentConfig();
    } else if (choice === "4") {
      await resetConfig();
    } else if (choice === "5") {
      console.log("\n👋 Goodbye!");
      break;
    } else {
      console.log("❌ Invalid choice");
    }
  }

  rl.close();
}

main().catch(console.error);
