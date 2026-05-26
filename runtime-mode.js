export function normalizeBooleanFlag(value) {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
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

  return resolved;
}

export { DEVNET_RPC, DEVNET_FAUCET_AMOUNT_SOL, DEVNET_FAUCET_MIN_BALANCE };
