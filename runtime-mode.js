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
  if (normalizedMode === "demo" || normalizedMode === "dry" || normalizedMode === "dry-run") {
    mode = "demo";
  } else if (normalizedMode === "live") {
    mode = "live";
  } else if (demoFlag === true || dryRunFlag === true) {
    mode = "demo";
  }

  const isDemo = mode === "demo";

  // ── DEMO mode: use devnet for real fake-money transactions ──
  // Devnet SOL is free and unlimited via faucet airdrops.
  // This means DEMO executes REAL on-chain swaps using devnet SOL —
  // the full pipeline (Jupiter swap, confirm, slippage, etc.) works
  // exactly like LIVE, but with fake money.
  const devnet = isDemo ? {
    enabled: true,
    rpcUrl: env.DEVNET_RPC_URL || userConfig.devnetRpcUrl || DEVNET_RPC,
    wssUrl: env.DEVNET_WSS_URL || userConfig.devnetWssUrl || DEVNET_WSS,
    faucetAmountSol: DEVNET_FAUCET_AMOUNT_SOL,
    faucetMinBalance: DEVNET_FAUCET_MIN_BALANCE,
    // Demo wallet: if user configured a specific devnet key, use it.
    // Otherwise derive from the main wallet or use a throwaway.
    walletKey: env.DEVNET_WALLET_KEY || userConfig.devnetWalletKey || null,
  } : { enabled: false };

  return {
    mode,
    isDemo,
    isLive: mode === "live",
    label: isDemo ? "DEMO (devnet)" : "LIVE (mainnet)",
    // DEMO no longer sets dryRun=true — we want real transactions on devnet
    legacyDryRun: false,
    devnet,
  };
}

export function applyExecutionMode(options = {}) {
  const resolved = resolveExecutionMode(options);
  process.env.EXECUTION_MODE = resolved.mode;
  process.env.DEMO_MODE = String(resolved.isDemo);

  // DEMO mode no longer forces DRY_RUN — we use devnet for real swaps
  process.env.DRY_RUN = "false";

  // Apply devnet RPC in DEMO mode
  if (resolved.devnet.enabled) {
    if (!process.env.RPC_URL) process.env.RPC_URL = resolved.devnet.rpcUrl;
    if (!process.env.WSS_URL) process.env.WSS_URL = resolved.devnet.wssUrl;
    if (resolved.devnet.walletKey && !process.env.DEVNET_WALLET_KEY) {
      process.env.DEVNET_WALLET_KEY = resolved.devnet.walletKey;
    }
  }

  return resolved;
}

export { DEVNET_RPC, DEVNET_FAUCET_AMOUNT_SOL, DEVNET_FAUCET_MIN_BALANCE };
