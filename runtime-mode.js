import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const _MODE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function normalizeBooleanFlag(value) {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

/**
 * DEMO_STRICT_GATES — opt-in fidelity switch. When ON (demo only), the live
 * execution gates also run in demo:
 *   • confirmMode parking — BUYs are parked as pending intents needing /yes
 *   • balance safety-check — verifies the (virtual) balance covers amount+gas
 * so the approval flow and safety gate get exercised against the virtual
 * balance. OFF by default (demo stays fast/frictionless). Callers already
 * guard on DRY_RUN, so this only takes effect in demo.
 */
export function demoStrictGates() {
  return normalizeBooleanFlag(process.env.DEMO_STRICT_GATES) === true;
}

/**
 * Learning / trade-outcome stores to ISOLATE in paper mode so simulated trades
 * never pollute the live decision corpus. Map: env override → default filename.
 * (Stores that already read these env vars need no change; the rest get a
 * one-line `process.env.X || default` added.)
 *
 * Pure-market observations (smart-wallet-history) and ops counters (metrics) are
 * intentionally LEFT SHARED — they're real on-chain data, mode-independent.
 */
export const PAPER_REDIRECT_STORES = {
  PONYOU_STATE_FILE:             "state.json",              // open positions
  PONYOU_CONVICTION_FILE:        "coin-conviction.json",
  PONYOU_PROFIT_PATTERNS_FILE:   "profit-patterns.json",
  PONYOU_LOSS_PATTERNS_FILE:     "loss-patterns.json",
  PONYOU_LESSONS_FILE:           "lessons.json",
  PONYOU_PERF_FILE:              "performance.json",
  PONYOU_DARWIN_FILE:            "darwin-weights.json",
  PONYOU_RUG_MEMORY_FILE:        "rug-memory.json",
  PONYOU_RUG_PATTERNS_FILE:      "rug-patterns-learned.json",
  PONYOU_REGIME_FILE:            "regime-memory.json",
  PONYOU_TRADE_ATTRIBUTION_FILE: "trade-attribution.json",
  PONYOU_EXEC_QUALITY_FILE:      "execution-quality.json",
  PONYOU_DAILY_GUARD_STATE:      "daily-trade-guard-state.json",
  PONYOU_PLAN_FILE:              "trading-plan.json",
  // Safety state: recordSwapOutcome() runs in demo too, so a paper-trade
  // losing streak must NOT trip the live kill-switch / daily guard.
  PONYOU_KILL_SWITCH_STATE:      "kill-switch-state.json",
  PONYOU_KILL_SWITCH_FLAG:       "kill-switch.flag",
};

/**
 * When paper mode is active (demo + PAPER_TRADING not disabled), point every
 * learning/trade store at a `demo/` subdir — UNLESS the env var is already set
 * (test isolation wins). Returns the demo dir, or null when not applied.
 *
 * Must run before any store evaluates its path const; callers ensure config.js
 * (which calls this via applyExecutionMode) loads first.
 */
export function applyPaperDataRedirect({ isDemo, env = process.env, baseDir = _MODE_DIR } = {}) {
  const paperActive = !!isDemo && normalizeBooleanFlag(env.PAPER_TRADING) !== false;
  if (!paperActive) return null;
  const dir = path.join(baseDir, "demo");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  for (const [k, fname] of Object.entries(PAPER_REDIRECT_STORES)) {
    if (!env[k]) env[k] = path.join(dir, fname); // ||= : explicit override wins
  }
  return dir;
}

const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_WSS = "wss://api.devnet.solana.com";
const MAINNET_RPC_FALLBACK = "https://api.mainnet-beta.solana.com";
const DEVNET_FAUCET_AMOUNT_SOL = 2;  // devnet airdrop max
const DEVNET_FAUCET_MIN_BALANCE = 0.5; // refill if below this

export function resolveExecutionMode({
  env = process.env,
  userConfig = {},
} = {}) {
  const rawMode =
    userConfig.executionMode ??
    env.EXECUTION_MODE ??
    null;

  const rawDemo =
    userConfig.demoMode ??
    env.DEMO_MODE ??
    null;

  const rawDryRun =
    userConfig.dryRun ??
    env.DRY_RUN ??
    null;

  const normalizedMode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : null;
  const demoFlag = normalizeBooleanFlag(rawDemo);
  const dryRunFlag = normalizeBooleanFlag(rawDryRun);

  let mode = "live";
  // Explicit mode strings — "false", "off", "no" are NOT valid modes, treat as live
  if (normalizedMode === "demo" || normalizedMode === "dry" || normalizedMode === "dry-run") {
    mode = "demo";
  } else if (normalizedMode === "live") {
    mode = "live";
  } else if (demoFlag === true || dryRunFlag === true) {
    mode = "demo";
  } else if (demoFlag === false && dryRunFlag === false) {
    mode = "live";
  } else if (!normalizedMode) {
    // No mode specified, use boolean flags or default to live
    mode = "live";
  }

  const isDemo = mode === "demo";

  // ── DEMO mode: paper trading with mainnet data ──
  // Demo uses MAINNET RPC for all reads (screening, quotes, prices)
  // and SIMULATES execution — no real SOL is ever spent.
  //
  // For real on-chain testing with devnet tokens (free devnet SOL),
  // set rpcUrl to a devnet endpoint in user-config.json explicitly.
  // The faucet will auto-fund the wallet in that case.
  // Devnet is only ACTIVE when the user is using a devnet RPC endpoint.
  // demo mode with mainnet RPC does NOT use devnet, even though demo
  // simulates execution. The `enabled` flag reflects whether devnet
  // RPC + faucet should be used, not just whether we're in demo mode.
  const userWantsDevnet = (userConfig.rpcUrl || "").includes("devnet") ||
                          (env.RPC_URL || "").includes("devnet");
  const devnet = (isDemo && userWantsDevnet) ? {
    enabled: true,
    rpcUrl: env.DEVNET_RPC_URL || userConfig.devnetRpcUrl || DEVNET_RPC,
    wssUrl: env.DEVNET_WSS_URL || userConfig.devnetWssUrl || DEVNET_WSS,
    faucetAmountSol: DEVNET_FAUCET_AMOUNT_SOL,
    faucetMinBalance: DEVNET_FAUCET_MIN_BALANCE,
    walletKey: env.DEVNET_WALLET_KEY || userConfig.devnetWalletKey || null,
  } : { enabled: false };

  return {
    mode,
    isDemo,
    isLive: mode === "live",
    label: isDemo ? "DEMO (paper trade)" : "LIVE (mainnet)",
    // DEMO = paper trading: mainnet data, simulated execution, no real SOL spent
    legacyDryRun: isDemo ? true : false,
    devnet,
  };
}

export function applyExecutionMode(options = {}) {
  const resolved = resolveExecutionMode(options);
  const userConfig = options.userConfig || {};
  const env = options.env || process.env;
  process.env.EXECUTION_MODE = resolved.mode;
  process.env.DEMO_MODE = String(resolved.isDemo);

  // DEMO mode = paper trading: mainnet data, simulated execution
  // Keep mainnet RPC for reads (screening, quotes, prices).
  // Only override to devnet if user explicitly set a devnet RPC in user-config.
  if (resolved.isDemo) {
    const userWantsDevnet = (userConfig.rpcUrl || "").includes("devnet") ||
                            (env.RPC_URL || "").includes("devnet");
    if (userWantsDevnet && resolved.devnet.enabled) {
      process.env.RPC_URL = resolved.devnet.rpcUrl;
      process.env.WSS_URL = resolved.devnet.wssUrl;
      if (resolved.devnet.walletKey) {
        process.env.DEVNET_WALLET_KEY = resolved.devnet.walletKey;
      }
    }
    // Paper trading: simulate execution, don't send real transactions
    process.env.DRY_RUN = "true";
  } else {
    process.env.DRY_RUN = "false";
  }

  // Isolate paper-trade learning into demo/ so it never pollutes live stores.
  applyPaperDataRedirect({ isDemo: resolved.isDemo, env: process.env });

  return resolved;
}

export { DEVNET_RPC, DEVNET_FAUCET_AMOUNT_SOL, DEVNET_FAUCET_MIN_BALANCE };
