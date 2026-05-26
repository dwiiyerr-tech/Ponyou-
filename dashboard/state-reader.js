import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

function readJson(filename, fallback = {}) {
  try {
    const fp = path.join(BASE_PATH, filename);
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

  const positions = Object.values(state.positions || {})
    .filter(p => !p?.closed)
    .map(p => ({
      symbol: p.symbol || "?",
      mint: p.mint || "",
      pnl_pct: p.pnl_pct ?? 0,
      hold_minutes: p.deployed_at
        ? Math.round((Date.now() - new Date(p.deployed_at).getTime()) / 60000)
        : 0,
      entry_sol: p.initial_value_usd
        ? parseFloat((p.initial_value_usd / (state.sol_price || 150)).toFixed(4))
        : 0,
    }));

  const vaultCfg = cfg.vault?.sweep ?? cfg.vault ?? {};
  const planCfg = cfg.tradingPlan ?? {};

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
  };
}
