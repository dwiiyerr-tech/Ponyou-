import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

// Stores that get redirected to demo/ in paper mode (runtime-mode.js
// applyPaperDataRedirect). This reader runs IN the bot process, so the
// PONYOU_*_FILE env points at the exact file the bot is writing — honor it so
// the dashboard isn't blind while paper trading.
const ENV_OVERRIDE = {
  "state.json": "PONYOU_STATE_FILE",
  "execution-quality.json": "PONYOU_EXEC_QUALITY_FILE",
  "trading-plan.json": "PONYOU_PLAN_FILE",
};

function readJson(filename, fallback = {}) {
  try {
    const envVar = ENV_OVERRIDE[filename];
    const fp = (envVar && process.env[envVar]) || path.join(BASE_PATH, filename);
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch { return fallback; }
}

export async function readBotState() {
  const state = readJson("state.json");
  const vaultState = readJson("vault-state.json");
  const planState = readJson("trading-plan-state.json");
  const cfg = readJson("user-config.json");
  const quality = readJson("execution-quality.json");

  // SR-1: only compute entry_sol when sol_price is actually known. The
  // previous fallback of 150 silently lied to the dashboard when the
  // bot hadn't published a fresh SOL price yet — turning a $100 entry
  // into ~0.67 SOL regardless of the real rate.
  const knownSolPrice = Number(state.sol_price) > 0 ? Number(state.sol_price) : null;
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

  return {
    bot_running: Boolean(state.cron_started ?? false),
    balance_sol: state.balance_sol ?? 0,
    sol_price: state.sol_price ?? 0,
    pnl_today_usd: state.pnl_today_usd ?? 0,
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
  };
}
