import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { validateWalletTopology } from "./wallet-topology.js";
import bs58 from "bs58";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Data Floor Thresholds ─────────────────────────────────────────
// Only checked for LIVE mode. These ensure Ponyou has enough
// historical data to make informed decisions.
//
// Cold start (file doesn't exist yet) → WARNING only — you need to
//   accumulate data in demo mode first, but it's not a hard block.
// File exists but below minimum → HARD BLOCK — partial data is worse
//   than no data because it gives false confidence.

const MIN_CLOSED_TRADES = 20;        // minimum closed trades in attribution
const MIN_RUG_MEMORY = 15;           // known rug patterns in rug-memory.json
const MIN_MARKET_DAYS = 3;           // minimum days of market intelligence data
const MIN_LESSONS_ENTRIES = 10;      // minimum trade outcome lessons
const MIN_REGIME_OBSERVATIONS = 5;   // minimum regime observations
const MIN_CONVICTION_SAMPLES = 10;   // minimum conviction data points

// ─── Helpers ────────────────────────────────────────────────────────

function tryReadJson(filename) {
  try {
    const fp = path.join(__dirname, filename);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch { return null; }
}

function hasWalletConfigured({ env = process.env, runtime = {}, config = null } = {}) {
  if (runtime.hasActiveWallet) return true;
  const topology = validateWalletTopology({
    enabled: !!config?.multiWallet?.enabled,
    wallets: config?.multiWallet?.wallets || [],
  });
  if (topology.ok && topology.wallet_count > 0) return true;
  if (!env.WALLET_PRIVATE_KEY) return false;
  // T3-11: validate key FORMAT here so a malformed key fails readiness,
  // not silently at the first live swap. A valid Ed25519 secret key decodes
  // to exactly 64 bytes (seed + public key). Shorter decoded values are invalid.
  try {
    const decoded = bs58.decode(env.WALLET_PRIVATE_KEY);
    if (decoded.length !== 64) return false;
  } catch {
    return false;
  }
  return true;
}

function hasTelegramConfigured({ env = process.env } = {}) {
  return !!(env.TELEGRAM_BOT_TOKEN && (env.TELEGRAM_CHAT_ID || config.telegramChatId));
}

// ─── Data Floor Checks ──────────────────────────────────────────────

// ─── Helpers: differentiate cold start from insufficient data ──────

function dataFileCheck(filename, checkFn) {
  const data = tryReadJson(filename);
  if (data === null) {
    // File doesn't exist — cold start. This is a WARNING, not a block,
    // because you can't accumulate data without trading in demo first.
    return { passed: false, cold_start: true, message: `${filename} missing — cold start. Run in demo mode first to accumulate data.` };
  }
  return checkFn(data);
}

function checkTradingHistory(data) {
  const trades = data?.trades || [];
  if (trades.length < MIN_CLOSED_TRADES) {
    return {
      passed: false,
      message: `Trading history too thin: ${trades.length}/${MIN_CLOSED_TRADES} closed trades. Need ${MIN_CLOSED_TRADES - trades.length} more.`,
    };
  }
  const wins = trades.filter(t => (t.pnl_pct || t.pnlPct || 0) > 0).length;
  const liveWR = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : "0";
  return { passed: true, message: `${trades.length} closed trades (${liveWR}% WR) — sufficient history` };
}

// Trade-attribution is isolated to demo/ so simulated outcomes never reach live
// SIZING (which reads root-only). But the readiness gate SHOULD count demo
// practice so a smooth demo run opens the live door. So merge root + demo/
// trade-attribution for this check only. Returns null only when BOTH are absent
// (true cold start).
function readTradeAttributionForReadiness() {
  const root = tryReadJson("trade-attribution.json");
  const demo = tryReadJson(path.join("demo", "trade-attribution.json"));
  if (root === null && demo === null) return null;
  return {
    trades: [
      ...((root?.trades) || []),
      ...((demo?.trades) || []),
    ],
  };
}

function checkRugMemory(data) {
  const patterns = data?.patterns || [];
  const blacklistedTokens = data?.blacklisted_tokens || [];
  const blacklistedDevs = data?.blacklisted_devs || [];
  const totalRugs = patterns.length;
  if (totalRugs < MIN_RUG_MEMORY) {
    return {
      passed: false,
      message: `Rug memory too small: ${totalRugs}/${MIN_RUG_MEMORY} known rugs. Need ${MIN_RUG_MEMORY - totalRugs} more.`,
    };
  }
  return {
    passed: true,
    message: `${totalRugs} known rug patterns · ${blacklistedTokens.length} blacklisted tokens · ${blacklistedDevs.length} blacklisted devs`,
  };
}

function checkLessonsData(data) {
  const entries = data?.lessons || data?.entries || [];
  if (entries.length < MIN_LESSONS_ENTRIES) {
    return {
      passed: false,
      message: `Lessons too thin: ${entries.length}/${MIN_LESSONS_ENTRIES} entries. Need richer trade outcome history.`,
    };
  }
  return { passed: true, message: `${entries.length} lesson entries — sufficient learning history` };
}

function checkMarketIntelligence(data) {
  const snapshots = data?.snapshots || data?.history || [];
  if (snapshots.length < MIN_MARKET_DAYS) {
    return {
      passed: false,
      message: `Market intelligence too fresh: ${snapshots.length}/${MIN_MARKET_DAYS} snapshots. Need more observation days.`,
    };
  }
  const conditions = new Set(snapshots.map(s => s.condition).filter(Boolean));
  return { passed: true, message: `${snapshots.length} market snapshots across ${conditions.size} conditions` };
}

function checkRegimeMemory(data) {
  let regimes = data?.regimes || data?.observations || [];
  if (regimes && typeof regimes === "object" && !Array.isArray(regimes)) {
    regimes = Object.values(regimes);
  }
  if (!Array.isArray(regimes)) regimes = [];
  const totalObs = regimes.reduce((s, r) => s + ((r && (r.observations || r.trades || r.observation_count)) || 1), 0);
  if (totalObs < MIN_REGIME_OBSERVATIONS) {
    return {
      passed: false,
      message: `Regime memory too thin: ${totalObs}/${MIN_REGIME_OBSERVATIONS} observations. Need more per-regime data.`,
    };
  }
  return { passed: true, message: `${totalObs} regime observations — sufficient regime awareness` };
}

function checkConvictionMemory(data) {
  const coins = data?.coins || data?.entries || {};
  if (!coins || typeof coins !== "object") {
    return { passed: false, message: `Conviction data missing or unreadable.` };
  }
  const entries = Array.isArray(coins) ? coins : Object.values(coins);
  const totalSamples = entries.reduce((s, c) => s + ((c && (c.observation_count || c.observations || c.samples || c.trades)) || 1), 0);
  if (totalSamples < MIN_CONVICTION_SAMPLES) {
    return {
      passed: false,
      message: `Conviction data too thin: ${totalSamples}/${MIN_CONVICTION_SAMPLES} samples. Need more coin observation history.`,
    };
  }
  const uniqueCoins = entries.length;
  return { passed: true, message: `${totalSamples} conviction samples across ${uniqueCoins} coins` };
}

// ─── Main Readiness ──────────────────────────────────────────────────

export function getOperationalReadiness({
  env = process.env,
  executionMode = null,
  runtime = {},
  config: configOverride = null,
} = {}) {
  const runtimeConfig = configOverride || config;
  const mode = executionMode?.mode || env.EXECUTION_MODE || "live";
  const isLive = mode === "live";
  const errors = [];
  const warnings = [];
  const dataChecks = [];

  if ((runtimeConfig.management?.minSolToOpen ?? 0) <= (runtimeConfig.management?.gasReserve ?? 0)) {
    errors.push("minSolToOpen must be greater than gasReserve.");
  }

  if (isLive) {
    // ── Infrastructure checks (hard blockers) ──────────────────
    if (!env.RPC_URL) {
      errors.push("RPC_URL is not configured.");
    }
    if (!hasWalletConfigured({ env, runtime, config: runtimeConfig })) {
      errors.push("No trading wallet is configured.");
    }
    const walletTopology = validateWalletTopology({
      enabled: !!runtimeConfig.multiWallet?.enabled,
      wallets: runtimeConfig.multiWallet?.wallets || [],
    });
    if (runtimeConfig.multiWallet?.enabled && !walletTopology.ok) {
      errors.push(...walletTopology.errors);
    }
    // Helius API key is now optional when GMGN is configured — GMGN covers rug
    // signals, holder enrichment, wallet scoring, and smart money tracking.
    const heliusMissing = !env.HELIUS_API_KEY || env.HELIUS_API_KEY === "dummy-helius-key";
    const gmgnPresent = !!(env.GMGN_API_KEY && env.GMGN_API_KEY !== "dummy-gmgn-key");
    if (heliusMissing && !gmgnPresent) {
      errors.push("HELIUS_API_KEY is missing and GMGN_API_KEY is not set. At least one data provider is required for live trading.");
    } else if (heliusMissing && gmgnPresent) {
      warnings.push("HELIUS_API_KEY is missing. GMGN is covering rug signals and enrichment, but some on-chain tx-history paths will be unavailable.");
    }

    // ── Data floor checks ──────────────────────────────────────────
    // Cold start (file missing): WARNING — you need to run demo first.
    // File exists but below minimum: ERROR — partial data is dangerous
    // because it creates false confidence without real statistical power.
    const rugCheck = dataFileCheck("rug-memory.json", checkRugMemory);
    dataChecks.push({ name: "Rug Memory", ...rugCheck });
    if (!rugCheck.passed) {
      if (rugCheck.cold_start) warnings.push(rugCheck.message);
      else errors.push(rugCheck.message);
    }

    // Merge root + demo/ trade-attribution: demo practice counts toward the
    // live-readiness gate, but live sizing still reads root-only (clean start).
    const historyData = readTradeAttributionForReadiness();
    const historyCheck = historyData === null
      ? { passed: false, cold_start: true, message: "trade-attribution.json missing — cold start. Run in demo mode first to accumulate data." }
      : checkTradingHistory(historyData);
    dataChecks.push({ name: "Trading History", ...historyCheck });
    if (!historyCheck.passed) {
      if (historyCheck.cold_start) warnings.push(historyCheck.message);
      else errors.push(historyCheck.message);
    }

    const lessonsCheck = dataFileCheck("lessons.json", checkLessonsData);
    dataChecks.push({ name: "Lessons", ...lessonsCheck });
    if (!lessonsCheck.passed) {
      if (lessonsCheck.cold_start) warnings.push(lessonsCheck.message);
      else errors.push(lessonsCheck.message);
    }

    const miCheck = dataFileCheck("market-intelligence.json", checkMarketIntelligence);
    dataChecks.push({ name: "Market Intelligence", ...miCheck });
    if (!miCheck.passed) {
      if (miCheck.cold_start) warnings.push(miCheck.message);
      else errors.push(miCheck.message);
    }

    const regimeCheck = dataFileCheck("regime-memory.json", checkRegimeMemory);
    dataChecks.push({ name: "Regime Memory", ...regimeCheck });
    if (!regimeCheck.passed) {
      if (regimeCheck.cold_start) warnings.push(regimeCheck.message);
      else errors.push(regimeCheck.message);
    }

    const convictionCheck = dataFileCheck("coin-conviction.json", checkConvictionMemory);
    dataChecks.push({ name: "Conviction Memory", ...convictionCheck });
    if (!convictionCheck.passed) {
      if (convictionCheck.cold_start) warnings.push(convictionCheck.message);
      else errors.push(convictionCheck.message);
    }

    // ── Soft warnings (not blockers, but important) ──────────
    if (!env.SHYFT_API_KEY && !gmgnPresent) {
      warnings.push("SHYFT_API_KEY is missing. Helius fallback provider unavailable.");
    }
    if (!runtimeConfig.trading?.confirmMode) {
      warnings.push("confirmMode is OFF. Live BUYs can execute immediately.");
    }
    if (!hasTelegramConfigured({ env })) {
      warnings.push("Telegram is not configured. Remote approvals and alerts are unavailable.");
    }
    if (runtimeConfig.multiWallet?.enabled && (!Array.isArray(runtimeConfig.multiWallet.wallets) || runtimeConfig.multiWallet.wallets.length < 2)) {
      warnings.push("multiWallet is enabled but fewer than 2 wallets are configured.");
    }
  } else {
    if (!env.RPC_URL) {
      warnings.push("RPC_URL is not configured. Some demo checks may fail.");
    }
    if (!hasWalletConfigured({ env, runtime, config: runtimeConfig })) {
      warnings.push("No trading wallet is configured. Demo mode will skip real balance validation.");
    }
    {
      const heliusMissingDemo = !env.HELIUS_API_KEY || env.HELIUS_API_KEY === "dummy-helius-key";
      const gmgnPresentDemo = !!(env.GMGN_API_KEY && env.GMGN_API_KEY !== "dummy-gmgn-key");
      if (heliusMissingDemo && !gmgnPresentDemo) {
        warnings.push("HELIUS_API_KEY is missing. Security enrichment and wallet checks will be degraded.");
      } else if (heliusMissingDemo && gmgnPresentDemo) {
        warnings.push("HELIUS_API_KEY is missing. GMGN active — most enrichment paths covered.");
      }
      if (!env.SHYFT_API_KEY && !gmgnPresentDemo) {
        warnings.push("SHYFT_API_KEY is missing. Helius fallback provider unavailable.");
      }
    }
  }

  return {
    mode,
    is_live: isLive,
    ok: errors.length === 0,
    errors,
    warnings,
    data_checks: dataChecks,
    summary: errors.length === 0
      ? `Readiness OK for ${isLive ? "LIVE" : "DEMO"} mode`
      : `Readiness blocked by ${errors.length} issue(s)`,
  };
}

export function formatReadinessReport(readiness) {
  const lines = [
    `Mode: ${String(readiness?.mode || "unknown").toUpperCase()}`,
    `Status: ${readiness?.ok ? "OK" : "BLOCKED"}`,
    `Summary: ${readiness?.summary || ""}`,
  ];

  if (Array.isArray(readiness?.errors) && readiness.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const error of readiness.errors) lines.push(`- ${error}`);
  }

  if (Array.isArray(readiness?.warnings) && readiness.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of readiness.warnings) lines.push(`- ${warning}`);
  }

  if (Array.isArray(readiness?.data_checks) && readiness.data_checks.length > 0) {
    lines.push("");
    lines.push("Data Floor Checks:");
    for (const check of readiness.data_checks) {
      const icon = check.passed ? "PASS" : check.cold_start ? "COLD" : "FAIL";
      lines.push(`  ${icon}  ${check.name}: ${check.message}`);
    }
    const coldCount = readiness.data_checks.filter(c => c.cold_start).length;
    if (coldCount > 0) {
      lines.push(`  (${coldCount} data files missing — run demo mode to accumulate trading data first)`);
    }
  }

  return lines.join("\n");
}

export function assertOperationalReadiness(options = {}) {
  const readiness = getOperationalReadiness(options);
  if (readiness.is_live && !readiness.ok) {
    const error = new Error(formatReadinessReport(readiness));
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}
