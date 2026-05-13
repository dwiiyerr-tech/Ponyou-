#!/usr/bin/env node
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "user-config.json");
const ENV_PATH = path.join(__dirname, ".env");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function question(prompt) {
  return new Promise((resolve) => rl.question(prompt, (a) => resolve(a.trim())));
}
function prompt(msg, defaultVal = "") {
  const suffix = defaultVal !== "" && defaultVal !== undefined ? ` [${defaultVal}]` : "";
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
async function promptSelect(msg, options, defaultIdx = 0) {
  console.log(`\n${msg}:`);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}${i === defaultIdx ? " (default)" : ""}`));
  let choice = await question(`Select (1-${options.length}): `);
  const idx = parseInt(choice) - 1;
  return idx >= 0 && idx < options.length ? options[idx] : options[defaultIdx];
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
  }
  return {};
}
function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    fs.readFileSync(ENV_PATH, "utf8").split("\n").forEach((line) => {
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
    "# Option B: LM Studio / Custom endpoint",
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
    "# ── Vault / Tabungan Otomatis ─────────────────────────────────────────────────",
    `VAULT_WALLET=${env.VAULT_WALLET || ""}`,
    "",
    "# ── Mode ───────────────────────────────────────────────────────────────────────",
    "# DRY_RUN: blokir swap, tetap butuh wallet & Helius key",
    `DRY_RUN=${env.DRY_RUN || "false"}`,
    "",
    "# DEMO_MODE: virtual trading tanpa uang asli (tidak butuh wallet/Helius)",
    `DEMO_MODE=${env.DEMO_MODE || "false"}`,
    `DEMO_INITIAL_SOL=${env.DEMO_INITIAL_SOL || "5.0"}`,
    "",
    `LOG_LEVEL=${env.LOG_LEVEL || "info"}`,
  ];
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n");
  console.log(`✓ Environment disimpan ke ${ENV_PATH}`);
}

// ─── Setup Sections ───────────────────────────────────────────

async function setupMode(cfg, env) {
  console.log("\n━━━ MODE OPERASI ━━━");
  console.log("  1. Live    — trading nyata dengan uang asli");
  console.log("  2. Dry Run — simulasi tanpa eksekusi (butuh wallet & Helius key)");
  console.log("  3. Demo    — virtual trading tanpa wallet/API key (untuk testing)");
  const mode = await question("Pilih mode [1/2/3]: ");
  if (mode === "2") {
    env.DRY_RUN = "true";
    env.DEMO_MODE = "false";
    console.log("→ Mode: DRY RUN");
  } else if (mode === "3") {
    env.DEMO_MODE = "true";
    env.DRY_RUN = "false";
    env.DEMO_INITIAL_SOL = String(await promptNumber("  Saldo SOL virtual awal", 5.0));
    console.log(`→ Mode: DEMO (${env.DEMO_INITIAL_SOL} SOL virtual)`);
  } else {
    env.DRY_RUN = "false";
    env.DEMO_MODE = "false";
    console.log("→ Mode: LIVE");
  }
}

async function setupWalletAndRpc(cfg, env) {
  console.log("\n━━━ WALLET & RPC ━━━");
  if (env.DEMO_MODE === "true") {
    console.log("ℹ️  Demo mode aktif — wallet & Helius key tidak wajib diisi.");
  }
  const walletKey = await prompt("  Wallet Private Key (base58)", cfg.walletKey || env.WALLET_PRIVATE_KEY || "");
  if (walletKey) { cfg.walletKey = walletKey; env.WALLET_PRIVATE_KEY = walletKey; }

  const rpcUrl = await prompt("  RPC URL", cfg.rpcUrl || env.RPC_URL || "https://pump.helius-rpc.com");
  if (rpcUrl) { cfg.rpcUrl = rpcUrl; env.RPC_URL = rpcUrl; }

  const heliusKey = await prompt("  Helius API Key", env.HELIUS_API_KEY || "");
  if (heliusKey) env.HELIUS_API_KEY = heliusKey;

  const gmgnKey = await prompt("  GMGN Route Key", env.GMGN_ROUTE_KEY || "");
  if (gmgnKey) env.GMGN_ROUTE_KEY = gmgnKey;
}

async function setupLlm(cfg, env) {
  console.log("\n━━━ LLM PROVIDER ━━━");
  const provider = await promptSelect("  Pilih LLM provider", [
    "OpenRouter (default, cloud)",
    "LM Studio (local, gratis)",
    "Custom endpoint",
  ]);

  if (provider.startsWith("OpenRouter")) {
    env.OPENROUTER_API_KEY = await prompt("  OpenRouter API Key", env.OPENROUTER_API_KEY || "");
    cfg.llmModel = (await prompt("  Model", cfg.llmModel || "minimax/minimax-m2.7")) || cfg.llmModel || "minimax/minimax-m2.7";
    env.LLM_BASE_URL = ""; env.LLM_API_KEY = ""; env.LLM_MODEL = cfg.llmModel;
  } else if (provider.startsWith("LM Studio")) {
    env.LLM_BASE_URL = await prompt("  Base URL", env.LLM_BASE_URL || "http://localhost:1234/v1");
    env.LLM_API_KEY = await prompt("  API Key", env.LLM_API_KEY || "lm-studio");
    cfg.llmModel = await prompt("  Model name", cfg.llmModel || "");
    env.LLM_MODEL = cfg.llmModel;
    env.OPENROUTER_API_KEY = "";
  } else {
    env.LLM_BASE_URL = await prompt("  Base URL", env.LLM_BASE_URL || "");
    env.LLM_API_KEY = await prompt("  API Key", env.LLM_API_KEY || "");
    cfg.llmModel = await prompt("  Model name", cfg.llmModel || "");
    env.LLM_MODEL = cfg.llmModel;
    env.OPENROUTER_API_KEY = "";
  }
  cfg.managementModel = cfg.llmModel;
  cfg.screeningModel = cfg.llmModel;
  cfg.generalModel = cfg.llmModel;
}

async function setupStrategy(cfg) {
  console.log("\n━━━ STRATEGI TRADING ━━━");
  console.log("  1. sniper      — Entry cepat token baru. High risk, high reward.");
  console.log("  2. dip_buy     — Beli saat harga dip jauh dari ATH.");
  console.log("  3. smart_money — Ikuti wallet smart money. Kualitas tinggi.");
  console.log("  4. degen       — Aggressive high risk. Untuk market EXTREME.");
  const stratChoice = await question("  Pilih strategi [1/2/3/4]: ");
  const stratMap = { "1": "sniper", "2": "dip_buy", "3": "smart_money", "4": "degen" };
  cfg.strategy = stratMap[stratChoice] || "sniper";
  console.log(`→ Strategi: ${cfg.strategy}`);

  if (cfg.strategy === "dip_buy") {
    cfg.athFilterPct = await promptNumber("  ATH distance minimum (%) misal -40 = beli jika 40% di bawah ATH", -40);
  }
}

async function setupPositionAndSol(cfg) {
  console.log("\n━━━ WALLET & POSISI ━━━");
  cfg.deployAmountSol = await promptNumber("  Deploy amount per trade (SOL)", cfg.deployAmountSol ?? 0.5);
  cfg.maxPositions = await promptNumber("  Max posisi terbuka sekaligus", cfg.maxPositions ?? 3);
  cfg.minSolToOpen = await promptNumber("  Min SOL di wallet untuk buka posisi", cfg.minSolToOpen ?? 0.55);
  cfg.gasReserve = await promptNumber("  Cadangan SOL untuk gas", cfg.gasReserve ?? 0.2);
  cfg.positionSizePct = await promptNumber("  % wallet per posisi (compounding, 0.35 = 35%)", cfg.positionSizePct ?? 0.35);
  cfg.maxDeployAmount = await promptNumber("  Max deploy amount (USD)", cfg.maxDeployAmount ?? 50);
}

async function setupExitRules(cfg) {
  console.log("\n━━━ EXIT RULES (STOPLOSS & TAKE PROFIT) ━━━");
  cfg.stopLossPct = await promptNumber("  Stop loss (%) misal -15 = keluar jika rugi 15%", cfg.stopLossPct ?? -15);
  cfg.takeProfitPct = await promptNumber("  Take profit (%) misal 30 = ambil profit di 30%", cfg.takeProfitPct ?? 30);
  cfg.trailingTakeProfit = await promptYesNo("  Aktifkan trailing take profit?", cfg.trailingTakeProfit !== false);
  if (cfg.trailingTakeProfit) {
    cfg.trailingTriggerPct = await promptNumber("  Aktifkan trailing saat profit > X%", cfg.trailingTriggerPct ?? 20);
    cfg.trailingDropPct = await promptNumber("  Close jika turun X% dari peak", cfg.trailingDropPct ?? 5);
  }
}

async function setupScanner(cfg) {
  console.log("\n━━━ SCANNER / SCREENING ━━━");
  cfg.minMcap = await promptNumber("  Min market cap ($)", cfg.minMcap ?? 150000);
  cfg.maxMcap = await promptNumber("  Max market cap ($)", cfg.maxMcap ?? 10000000);
  cfg.minVolume = await promptNumber("  Min volume 24h ($)", cfg.minVolume ?? 500);
  cfg.minHolders = await promptNumber("  Min jumlah holder", cfg.minHolders ?? 500);
  cfg.minTvl = await promptNumber("  Min TVL pool ($)", cfg.minTvl ?? 10000);
  cfg.maxTvl = await promptNumber("  Max TVL pool ($)", cfg.maxTvl ?? 150000);
  cfg.maxBundlePct = await promptNumber("  Max bundle holder (%)", cfg.maxBundlePct ?? 30);
  cfg.maxTop10Pct = await promptNumber("  Max top-10 holder konsentrasi (%)", cfg.maxTop10Pct ?? 60);
  cfg.maxBotHoldersPct = await promptNumber("  Max bot holder (%)", cfg.maxBotHoldersPct ?? 30);
  cfg.minTokenFeesSol = await promptNumber("  Min global fees SOL (anti wash-trading)", cfg.minTokenFeesSol ?? 30);
  cfg.minOrganic = await promptNumber("  Min organic score (%)", cfg.minOrganic ?? 60);

  console.log("\n  Signal Sources:");
  cfg.useTrendingSignals = await promptYesNo("  Gunakan trending signal source?", cfg.useTrendingSignals !== false);
  cfg.useGraduatedSignals = await promptYesNo("  Gunakan graduated (pump.fun) signal source?", cfg.useGraduatedSignals !== false);
}

async function setupManagement(cfg) {
  console.log("\n━━━ SCHEDULE MANAGEMENT ━━━");
  cfg.managementIntervalMin = await promptNumber("  Cek posisi setiap X menit", cfg.managementIntervalMin ?? 10);
  cfg.screeningIntervalMin = await promptNumber("  Scan token baru setiap X menit", cfg.screeningIntervalMin ?? 30);
}

async function setupPilot(cfg) {
  console.log("\n━━━ TRADING PLAN (COMPOUND 30 HARI) ━━━");
  cfg.pilotEnabled = await promptYesNo("  Aktifkan compound trading plan?", cfg.pilotEnabled !== false);
  if (cfg.pilotEnabled) {
    cfg.pilotCapitalUsd = await promptNumber("  Modal awal (USD)", cfg.pilotCapitalUsd ?? 10);
    cfg.dailyTargetPct = await promptNumber("  Target profit harian (%)", cfg.dailyTargetPct ?? 25);
    cfg.dailyStopLossPct = await promptNumber("  Stop loss harian (%)", cfg.dailyStopLossPct ?? -10);
    cfg.planDays = await promptNumber("  Durasi plan (hari)", cfg.planDays ?? 30);
    cfg.autoAdaptToMarket = await promptYesNo("  Auto adapt ke market conditions?", cfg.autoAdaptToMarket !== false);
  }
}

async function setupTelegram(env) {
  console.log("\n━━━ TELEGRAM NOTIFICATIONS ━━━");
  const enable = await promptYesNo("  Setup Telegram bot?", !!(env.TELEGRAM_BOT_TOKEN));
  if (enable) {
    env.TELEGRAM_BOT_TOKEN = await prompt("  Bot Token", env.TELEGRAM_BOT_TOKEN || "");
    env.TELEGRAM_CHAT_ID = await prompt("  Chat ID", env.TELEGRAM_CHAT_ID || "");
    env.TELEGRAM_ALLOWED_USER_IDS = await prompt("  Allowed User IDs (pisahkan koma)", env.TELEGRAM_ALLOWED_USER_IDS || "");
  }
}

async function setupVault(cfg, env) {
  console.log("\n━━━ VAULT: TABUNGAN OTOMATIS ━━━");
  const enableVault = await promptYesNo("  Aktifkan vault (kirim % profit ke wallet lain)?", !!(cfg.vaultWallet || env.VAULT_WALLET));
  if (enableVault) {
    const addr = await prompt("  Vault wallet address", cfg.vaultWallet || env.VAULT_WALLET || "");
    cfg.vaultWallet = addr; env.VAULT_WALLET = addr;
    cfg.vaultPct = await promptNumber("  % profit untuk vault", cfg.vaultPct ?? 35);
    cfg.vaultIntervalDays = await promptNumber("  Interval transfer (hari)", cfg.vaultIntervalDays ?? 7);
  } else {
    cfg.vaultWallet = ""; env.VAULT_WALLET = "";
  }
}

async function setupAdvanced(cfg) {
  const showAdv = await promptYesNo("\n  Tampilkan advanced settings?", false);
  if (!showAdv) return;

  console.log("\n━━━ ADVANCED ━━━");
  cfg.temperature = await promptNumber("  LLM temperature", cfg.temperature ?? 0.373);
  cfg.maxSteps = await promptNumber("  LLM max steps per cycle", cfg.maxSteps ?? 20);
  cfg.maxTokens = await promptNumber("  LLM max tokens", cfg.maxTokens ?? 4096);

  cfg.darwinEnabled = await promptYesNo("  Aktifkan Darwinian signal weighting?", cfg.darwinEnabled !== false);
  if (cfg.darwinEnabled) {
    cfg.darwinWindowDays = await promptNumber("  Darwin window (hari)", cfg.darwinWindowDays ?? 60);
    cfg.darwinBoost = await promptNumber("  Boost factor (sinyal bagus)", cfg.darwinBoost ?? 1.05);
    cfg.darwinDecay = await promptNumber("  Decay factor (sinyal buruk)", cfg.darwinDecay ?? 0.95);
  }

  cfg.chartIndicators = cfg.chartIndicators || {};
  cfg.chartIndicators.enabled = await promptYesNo("  Aktifkan chart indicators (RSI, SuperTrend)?", cfg.chartIndicators.enabled);
  if (cfg.chartIndicators.enabled) {
    cfg.chartIndicators.rsiLength = await promptNumber("  RSI length", cfg.chartIndicators.rsiLength ?? 14);
    cfg.chartIndicators.candles = await promptNumber("  Jumlah candles", cfg.chartIndicators.candles ?? 100);
  }

  cfg.dailyReportEnabled = await promptYesNo("  Aktifkan laporan harian?", cfg.dailyReportEnabled !== false);
  if (cfg.dailyReportEnabled) {
    cfg.dailyReportHourUtc = await promptNumber("  Jam UTC laporan (0-23)", cfg.dailyReportHourUtc ?? 0);
  }
}

function printSummary(cfg, env) {
  const mode = env.DEMO_MODE === "true" ? `DEMO (${env.DEMO_INITIAL_SOL} SOL virtual)` :
               env.DRY_RUN === "true" ? "DRY RUN" : "LIVE";
  console.log("\n┌──────────────────────────────────────────────────┐");
  console.log("│              RINGKASAN KONFIGURASI               │");
  console.log("├──────────────────────────────────────────────────┤");
  console.log(`│  Mode         : ${mode.padEnd(32)}│`);
  console.log(`│  Strategi     : ${(cfg.strategy || "sniper").padEnd(32)}│`);
  console.log(`│  Deploy/trade : ${String(cfg.deployAmountSol || 0.5).padEnd(28)} SOL │`);
  console.log(`│  Max posisi   : ${String(cfg.maxPositions || 3).padEnd(32)}│`);
  console.log(`│  Stop Loss    : ${String(cfg.stopLossPct || -15).padEnd(30)} % │`);
  console.log(`│  Take Profit  : ${String(cfg.takeProfitPct || 30).padEnd(30)} % │`);
  console.log(`│  Screen setiap: ${String(cfg.screeningIntervalMin || 30).padEnd(27)} mnt │`);
  console.log(`│  Min MCap     : $${String(cfg.minMcap || 150000).padEnd(31)}│`);
  console.log(`│  Max MCap     : $${String(cfg.maxMcap || 10000000).padEnd(31)}│`);
  console.log(`│  Telegram     : ${(env.TELEGRAM_BOT_TOKEN ? "✓ configured" : "✗ tidak aktif").padEnd(32)}│`);
  console.log(`│  Vault        : ${(cfg.vaultWallet ? `✓ ${cfg.vaultPct}% tiap ${cfg.vaultIntervalDays}h` : "✗ tidak aktif").padEnd(32)}│`);
  console.log("└──────────────────────────────────────────────────┘");
}

// ─── View / Reset ─────────────────────────────────────────────

async function viewCurrentConfig() {
  const cfg = loadConfig();
  const env = loadEnv();
  console.log("\n━━━ user-config.json ━━━\n");
  console.log(JSON.stringify(cfg, null, 2));
  console.log("\n━━━ .env (keys tersembunyi) ━━━");
  const safeMask = (v) => v ? v.slice(0, 6) + "..." : "(kosong)";
  console.log(`  WALLET_PRIVATE_KEY : ${safeMask(env.WALLET_PRIVATE_KEY)}`);
  console.log(`  HELIUS_API_KEY     : ${safeMask(env.HELIUS_API_KEY)}`);
  console.log(`  GMGN_ROUTE_KEY     : ${safeMask(env.GMGN_ROUTE_KEY)}`);
  console.log(`  OPENROUTER_API_KEY : ${safeMask(env.OPENROUTER_API_KEY)}`);
  console.log(`  TELEGRAM_BOT_TOKEN : ${safeMask(env.TELEGRAM_BOT_TOKEN)}`);
  console.log(`  DRY_RUN            : ${env.DRY_RUN || "false"}`);
  console.log(`  DEMO_MODE          : ${env.DEMO_MODE || "false"}`);
}

async function resetConfig() {
  const confirm = await promptYesNo("\n⚠️  Ini akan menghapus user-config.json. Lanjutkan?", false);
  if (confirm) {
    if (fs.existsSync(CONFIG_PATH)) { fs.unlinkSync(CONFIG_PATH); console.log("✓ user-config.json dihapus"); }
    else console.log("Tidak ada config untuk dihapus.");
  }
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║       PONYOU SETUP WIZARD v2.3           ║");
  console.log("║    Interactive Configuration Tool        ║");
  console.log("╚══════════════════════════════════════════╝\n");

  while (true) {
    console.log("\n┌─ MENU UTAMA ─────────────────────────────────┐");
    console.log("│  1. Full Setup     — wizard lengkap step-by-step │");
    console.log("│  2. Quick Setup    — essentials saja (5 menit)   │");
    console.log("│  3. Ganti Mode     — Live / Dry Run / Demo        │");
    console.log("│  4. Ganti Strategi — sniper/dip_buy/smart/degen  │");
    console.log("│  5. View Config    — lihat konfigurasi saat ini   │");
    console.log("│  6. Reset Config   — hapus user-config.json       │");
    console.log("│  7. Exit                                          │");
    console.log("└───────────────────────────────────────────────────┘");

    const choice = await question("\nPilih [1-7]: ");

    if (choice === "1") {
      const cfg = loadConfig();
      const env = loadEnv();
      await setupMode(cfg, env);
      await setupWalletAndRpc(cfg, env);
      await setupLlm(cfg, env);
      await setupStrategy(cfg);
      await setupPositionAndSol(cfg);
      await setupExitRules(cfg);
      await setupScanner(cfg);
      await setupManagement(cfg);
      await setupPilot(cfg);
      await setupTelegram(env);
      await setupVault(cfg, env);
      await setupAdvanced(cfg);
      printSummary(cfg, env);
      const ok = await promptYesNo("\nSimpan konfigurasi ini?", true);
      if (ok) { saveConfig(cfg); saveEnv(env); console.log("\n✅ Setup selesai! Jalankan:"); printRunCommands(env); }

    } else if (choice === "2") {
      const cfg = loadConfig();
      const env = loadEnv();
      await setupMode(cfg, env);
      await setupWalletAndRpc(cfg, env);
      await setupLlm(cfg, env);
      await setupStrategy(cfg);
      await setupPositionAndSol(cfg);
      await setupExitRules(cfg);
      printSummary(cfg, env);
      const ok = await promptYesNo("\nSimpan?", true);
      if (ok) { saveConfig(cfg); saveEnv(env); console.log("\n✅ Quick setup selesai!"); printRunCommands(env); }

    } else if (choice === "3") {
      const cfg = loadConfig();
      const env = loadEnv();
      await setupMode(cfg, env);
      saveEnv(env);
      console.log("✓ Mode diperbarui.");

    } else if (choice === "4") {
      const cfg = loadConfig();
      await setupStrategy(cfg);
      saveConfig(cfg);
      console.log("✓ Strategi diperbarui.");

    } else if (choice === "5") {
      await viewCurrentConfig();

    } else if (choice === "6") {
      await resetConfig();

    } else if (choice === "7") {
      console.log("\n👋 Goodbye!\n");
      break;
    } else {
      console.log("❌ Pilihan tidak valid.");
    }
  }

  rl.close();
}

function printRunCommands(env) {
  if (env.DEMO_MODE === "true") {
    console.log("   npm run demo        # virtual trading");
    console.log("   npm run demo:reset  # reset saldo virtual\n");
  } else if (env.DRY_RUN === "true") {
    console.log("   npm run dev         # dry run mode\n");
  } else {
    console.log("   npm run demo        # test dulu tanpa uang asli");
    console.log("   npm start           # live trading\n");
  }
}

main().catch(console.error);
