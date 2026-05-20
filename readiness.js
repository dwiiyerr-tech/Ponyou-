import { config } from "./config.js";
import { validateWalletTopology } from "./wallet-topology.js";

function hasWalletConfigured({ env = process.env, runtime = {}, config = null } = {}) {
  if (runtime.hasActiveWallet) return true;
  const topology = validateWalletTopology({
    enabled: !!config?.multiWallet?.enabled,
    wallets: config?.multiWallet?.wallets || [],
  });
  if (topology.ok && topology.wallet_count > 0) return true;
  return !!env.WALLET_PRIVATE_KEY;
}

function hasTelegramConfigured({ env = process.env } = {}) {
  return !!(env.TELEGRAM_BOT_TOKEN && (env.TELEGRAM_CHAT_ID || config.telegramChatId));
}

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

  if ((runtimeConfig.management?.minSolToOpen ?? 0) <= (runtimeConfig.management?.gasReserve ?? 0)) {
    errors.push("minSolToOpen must be greater than gasReserve.");
  }

  if (isLive) {
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
    if (!env.HELIUS_API_KEY || env.HELIUS_API_KEY === "dummy-helius-key") {
      errors.push("HELIUS_API_KEY is missing.");
    }
    if (!env.SHYFT_API_KEY) {
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
    if (!env.HELIUS_API_KEY || env.HELIUS_API_KEY === "dummy-helius-key") {
      warnings.push("HELIUS_API_KEY is missing. Security enrichment and wallet checks will be degraded.");
    }
    if (!env.SHYFT_API_KEY) {
      warnings.push("SHYFT_API_KEY is missing. Helius fallback provider unavailable.");
    }
  }

  return {
    mode,
    is_live: isLive,
    ok: errors.length === 0,
    errors,
    warnings,
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
