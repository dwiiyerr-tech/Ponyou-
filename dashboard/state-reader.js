import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getVaultDir } from "../secondbrain-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

// Stores redirected to demo/ in paper mode (runtime-mode.js). The dashboard
// bootstrap loads dotenv/config.js first, so these env paths match the files
// written by the bot. Explicit overrides still win for tests and deployments.
const ENV_OVERRIDE = {
  "state.json": "PONYOU_STATE_FILE",
  "execution-quality.json": "PONYOU_EXEC_QUALITY_FILE",
  "trading-plan.json": "PONYOU_PLAN_FILE",
  "kill-switch-state.json": "PONYOU_KILL_SWITCH_STATE",
  "metrics.json": "PONYOU_METRICS_FILE",
};

const SECOND_BRAIN_MAX_STARS = 500;
const SECOND_BRAIN_CACHE_MS = 10_000;
let secondBrainCache = {
  vaultDir: null,
  checkedAt: 0,
  data: null,
};

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function listMarkdownFiles(rootDir) {
  const files = [];

  function walk(dir) {
    if (files.length >= SECOND_BRAIN_MAX_STARS) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= SECOND_BRAIN_MAX_STARS) break;
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath);
    }
  }

  walk(rootDir);
  return files;
}

export function readSecondBrainVisuals(vaultDir = getVaultDir(), now = Date.now()) {
  if (
    secondBrainCache.data &&
    secondBrainCache.vaultDir === vaultDir &&
    now - secondBrainCache.checkedAt < SECOND_BRAIN_CACHE_MS
  ) {
    return secondBrainCache.data;
  }

  const empty = {
    available: false,
    file_count: 0,
    total_words: 0,
    last_updated: null,
    signature: "empty",
    stars: [],
  };

  if (!vaultDir || !fs.existsSync(vaultDir)) {
    secondBrainCache = { vaultDir, checkedAt: now, data: empty };
    return empty;
  }

  const stars = [];
  let totalWords = 0;
  let latestMtime = 0;

  for (const filePath of listMarkdownFiles(vaultDir)) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const stat = fs.statSync(filePath);
      const relativePath = path.relative(vaultDir, filePath);
      const pathHash = stableHash(relativePath);
      const contentHash = stableHash(content);
      const words = content.match(/\S+/g)?.length || 0;
      const headings = content.match(/^#{1,6}\s+/gm)?.length || 0;
      const ageDays = Math.max(0, now - stat.mtimeMs) / 86_400_000;
      const freshness = clamp(Math.exp(-ageDays / 30));
      const density = clamp(Math.log10(words + 1) / 3.5);
      const structure = clamp(headings / 12);
      const direction = (pathHash & 1) === 0 ? 1 : -1;
      const contentSignal = (contentHash % 1000) / 1000;

      totalWords += words;
      latestMtime = Math.max(latestMtime, stat.mtimeMs);
      stars.push({
        id: `brain-${pathHash.toString(36)}`,
        orbit: 0.08 + ((pathHash >>> 1) % 1000) / 1087,
        phase: ((pathHash >>> 11) % 1000) / 1000,
        speed: direction * (0.16 + freshness * 0.18 + contentSignal * 0.06),
        weight: 0.25 + density * 0.55 + structure * 0.2,
        freshness,
        pulse: 0.25 + contentSignal * 0.75,
        color_index: stableHash(relativePath.split(path.sep)[0] || "root") % 4,
      });
    } catch {
      // A note may be rewritten while the dashboard scans it. Skip this cycle.
    }
  }

  const signatureSource = stars
    .map((star) => `${star.id}:${star.weight.toFixed(3)}:${star.freshness.toFixed(3)}`)
    .join("|");
  const data = {
    available: true,
    file_count: stars.length,
    total_words: totalWords,
    last_updated: latestMtime ? new Date(latestMtime).toISOString() : null,
    signature: stableHash(signatureSource).toString(36),
    stars,
  };
  secondBrainCache = { vaultDir, checkedAt: now, data };
  return data;
}

function readJson(filename, fallback = {}) {
  try {
    const envVar = ENV_OVERRIDE[filename];
    const fp = (envVar && process.env[envVar]) || path.join(BASE_PATH, filename);
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch { return fallback; }
}

function fileMtimeMs(filename) {
  try {
    const envVar = ENV_OVERRIDE[filename];
    const fp = (envVar && process.env[envVar]) || path.join(BASE_PATH, filename);
    return fs.statSync(fp).mtimeMs;
  } catch { return null; }
}

export async function readBotState() {
  const state = readJson("state.json");
  const vaultState = readJson("vault-state.json");
  const planState = readJson("trading-plan-state.json");
  const cfg = readJson("user-config.json");
  const quality = readJson("execution-quality.json");
  // The bot's metrics snapshot is the only store a sidecar process can read
  // that the bot refreshes on every active cycle (flushed at most once a
  // minute). state.json only changes on position events, so it can sit
  // untouched for hours while the bot is perfectly alive.
  const metrics = readJson("metrics.json");
  const gauges = metrics.gauges || {};
  const killSwitch = readJson("kill-switch-state.json");

  // SR-1: only compute entry_sol when sol_price is actually known. The
  // previous fallback of 150 silently lied to the dashboard when the
  // bot hadn't published a fresh SOL price yet — turning a $100 entry
  // into ~0.67 SOL regardless of the real rate. The bot publishes
  // sol_price_usd as a metrics gauge each management cycle.
  const solPrice = Number(state.sol_price) > 0 ? Number(state.sol_price)
    : Number(gauges.sol_price_usd) > 0 ? Number(gauges.sol_price_usd)
    : 0;
  const knownSolPrice = solPrice > 0 ? solPrice : null;
  const positions = Object.values(state.positions || {})
    .filter(p => !p?.closed)
    .map(p => ({
      // Schema (state.js trackPosition): mint is `position`, symbol lives in
      // signal_snapshot/pool_name, and only `peak_pnl_pct` is persisted (live
      // pnl is computed in the management cycle, not stored here). Top-level
      // symbol/mint/pnl_pct kept as fallbacks for older snapshots.
      symbol: p.signal_snapshot?.symbol || p.pool_name || p.symbol || (p.position || "?").slice(0, 8),
      mint: p.position || p.mint || "",
      // Do NOT fall back to peak_pnl_pct here: it's monotonic (best-ever), so a
      // retraced position would render a falsely-positive "current" PnL. Show the
      // true current pnl (0 when unknown) and expose peak separately.
      pnl_pct: p.pnl_pct ?? 0,
      peak_pnl_pct: p.peak_pnl_pct ?? null,
      hold_minutes: p.deployed_at
        ? Math.round((Date.now() - new Date(p.deployed_at).getTime()) / 60000)
        : 0,
      entry_sol: p.initial_value_usd && knownSolPrice
        ? parseFloat((p.initial_value_usd / knownSolPrice).toFixed(4))
        : null,
    }));

  const vaultCfg = cfg.vault?.sweep ?? cfg.vault ?? {};
  const planCfg = cfg.tradingPlan ?? {};

  // Telegram user-client (MTProto) status — logs into the user's account to
  // watch monitored channels for incoming "calls". Lives in-process, so we read
  // it live; dynamic import keeps the reader usable in tests without telegram.
  let telegram = { enabled: false, connected: false };
  try {
    const { getUserClientStatus } = await import("../telegram-user-client.js");
    telegram = { ...getUserClientStatus(), bot_polling: Boolean(state.telegram_polling ?? false) };
  } catch { /* telegram module/dep unavailable — leave defaults */ }

  const lastUpdatedMs = Date.parse(state.lastUpdated || "");
  const stateFresh = Number.isFinite(lastUpdatedMs) && Date.now() - lastUpdatedMs <= 30_000;
  // SR-2: state.json freshness alone made the dashboard report STOPPED
  // whenever the book was quiet for >30s. A fresh metrics.json mtime is the
  // real cross-process heartbeat: the management cron (10 min) always records
  // activity, so 20 min of silence genuinely means the process is gone.
  const metricsMtime = fileMtimeMs("metrics.json");
  const metricsFresh = metricsMtime != null && Date.now() - metricsMtime <= 20 * 60_000;

  // state.json never carried pnl_today_usd / balance_sol — they rendered as
  // permanent zeros. Derive session PnL from the bot's last observed wallet
  // value vs the kill-switch session baseline (resets on bot restart).
  const walletUsd = Number(gauges.wallet_total_usd);
  const sessionBaseline = Number(killSwitch.sessionBaseline);
  const pnlSessionUsd = Number.isFinite(walletUsd) && sessionBaseline > 0
    ? walletUsd - sessionBaseline
    : 0;

  return {
    bot_running: Boolean(state.cron_started ?? (stateFresh || metricsFresh)),
    balance_sol: Number(state.balance_sol ?? gauges.balance_sol) || 0,
    sol_price: solPrice,
    pnl_today_usd: state.pnl_today_usd ?? pnlSessionUsd,
    positions,
    features: {
      vault_enabled: Boolean(vaultCfg.enabled ?? true),
      trading_plan_enabled: Boolean(planCfg.enabled ?? false),
      daily_guard_enabled: Boolean(
        cfg.dailyTradeGuard?.enabled ?? cfg.dailyTradeGuardEnabled ?? false
      ),
      learning_mode_active: Boolean(state.learning_mode_active ?? false),
      confirm_mode: Boolean(cfg.confirmMode ?? false),
      auto_enabled: Boolean(cfg.automationEnabled ?? true),
      trash_filter_enabled: Boolean(cfg.trashFilterEnabled ?? true),
      dev_blacklist_enabled: Boolean(cfg.devBlacklistEnabled ?? true),
      staged_entry_enabled: Boolean(cfg.stagedEntryEnabled ?? false),
      day_phase_enabled: Boolean(cfg.dayPhaseScreenerEnabled ?? false),
      strategy_evolution_enabled: Boolean(cfg.strategyEvolutionEnabled ?? false),
      rug_check_enabled: Boolean(cfg.rugCheckEnabled ?? true),
      sell_sim_enabled: Boolean(cfg.sellSimEnabled ?? true),
      rug_anomaly_enabled: Boolean(cfg.rugAnomalyEnabled ?? true),
      darwin_enabled: Boolean(cfg.darwinEnabled ?? false),
      paper_trading: Boolean(
        cfg.paperTrading ?? (
          process.env.PAPER_TRADING === "true" ||
          process.env.DRY_RUN === "true" ||
          process.env.EXECUTION_MODE === "demo"
        )
      ),
    },
    trading_plan: {
      enabled: Boolean(planCfg.enabled ?? false),
      trades_completed: planState.trades_completed ?? 0,
      target: planState.target ?? (planCfg.targetTrades ?? 30),
      remaining: Math.max(
        0,
        (planState.target ?? 30) - (planState.trades_completed ?? 0)
      ),
    },
    vault: {
      total_vaulted_sol: vaultState.totalVaultedSol ?? 0,
      last_vault_date: vaultState.lastVaultDate ?? null,
      vault_wallet: vaultCfg.vaultWallet ?? cfg.vaultWallet ?? null,
    },
    win_rate: quality.win_rate ?? null,
    telegram,
    second_brain: readSecondBrainVisuals(),
    // Trade timeline for the monitor — wallet addresses deliberately omitted.
    // (The old brain_metrics/skill_metrics fields were Math.random() theater;
    // removed rather than fixed — there is no real signal behind them.)
    recent_events: (state.recentEvents || []).slice(-40).reverse().map(e => ({
      ts: e.ts || null,
      action: e.action || "?",
      symbol: e.pool_name || e.symbol || (e.position || "?").slice(0, 8),
      reason: e.reason || null,
    })),
    wallet_topology: state.walletTopology ?? { multi_wallet_enabled: false, wallets: [] }
  };
}
