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
 * Stores isolated in demo/ so paper trading cannot trigger live kill-switches,
 * mix positions with real trades, or pollute live execution routing with
 * SIMULATED telemetry.
 *
 * Two categories isolated:
 *   1. Safety/session: state, kill-switch, daily-guard, plan.
 *   2. Simulated execution telemetry: trade-attribution + execution-quality.
 *      In DRY_RUN every swap "succeeds" with fake slippage/latency, so sharing
 *      these would mislead live wallet routing + position sizing. The readiness
 *      gate still counts demo trade-attribution via a demo/ fallback (see
 *      readiness.js) so demo practice opens the live door — but live SIZING
 *      reads root-only and starts clean. Mirrors scripts/promote-demo.js, which
 *      explicitly refuses to promote these two.
 *
 * Learning/knowledge stores (lessons, conviction, rug-memory, patterns, regime,
 * darwin-weights, performance) are intentionally LEFT SHARED — they are
 * mode-independent and accumulate during demo runs so the bot does not start
 * from zero when switching to live.
 *
 * Pure-market observations (smart-wallet-history, metrics) also stay shared —
 * they are real on-chain data, mode-independent.
 */
export const PAPER_REDIRECT_STORES = {
  PONYOU_STATE_FILE:             "state.json",
  PONYOU_KILL_SWITCH_STATE:      "kill-switch-state.json",
  PONYOU_KILL_SWITCH_FLAG:       "kill-switch.flag",
  PONYOU_DAILY_GUARD_STATE:      "daily-trade-guard-state.json",
  PONYOU_PLAN_FILE:              "trading-plan.json",
  PONYOU_TRADE_ATTRIBUTION_FILE: "trade-attribution.json",
  PONYOU_EXEC_QUALITY_FILE:      "execution-quality.json",
};

/**
 * When paper mode is active (demo + PAPER_TRADING not disabled), point safety/
 * session stores at a `demo/` subdir — UNLESS the env var is already set
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
    if (!env[k]) env[k] = path.join(dir, fname); // explicit override wins
  }
  return dir;
}

const DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_WSS = "wss://api.devnet.solana.com";
const DEVNET_FAUCET_AMOUNT_SOL = 2;
const DEVNET_FAUCET_MIN_BALANCE = 0.5;

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
  const demoFlag  = normalizeBooleanFlag(rawDemo);
  const dryRunFlag = normalizeBooleanFlag(rawDryRun);

  let mode = "live";
  if (normalizedMode === "demo" || normalizedMode === "dry" || normalizedMode === "dry-run") {
    mode = "demo";
  } else if (normalizedMode === "live") {
    mode = "live";
  } else if (demoFlag === true || dryRunFlag === true) {
    mode = "demo";
  } else if (demoFlag === false && dryRunFlag === false) {
    mode = "live";
  } else if (!normalizedMode) {
    mode = "live";
  }

  const isDemo = mode === "demo";

  // Demo may optionally point at a devnet RPC for data reads (rare use-case —
  // execution is still simulated / DRY_RUN=true regardless of RPC endpoint).
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
    legacyDryRun: isDemo,
    devnet,
  };
}

export function applyExecutionMode(options = {}) {
  const resolved = resolveExecutionMode(options);
  const userConfig = options.userConfig || {};
  const env = options.env || process.env;
  process.env.EXECUTION_MODE = resolved.mode;
  process.env.DEMO_MODE = String(resolved.isDemo);

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
    // Demo = paper trading: simulate execution, don't send real transactions.
    process.env.DRY_RUN = "true";
  } else {
    process.env.DRY_RUN = "false";
  }

  // Isolate paper-trade stores into demo/ so they never pollute live state.
  applyPaperDataRedirect({ isDemo: resolved.isDemo, env: process.env });

  return resolved;
}

export { DEVNET_RPC, DEVNET_FAUCET_AMOUNT_SOL, DEVNET_FAUCET_MIN_BALANCE };
