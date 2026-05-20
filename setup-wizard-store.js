import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveExecutionMode } from './runtime-mode.js';
import { getActiveStrategyId, listStrategies } from './strategies.js';
import { validateWalletTopology } from './wallet-topology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'user-config.json');
const ENV_PATH = path.join(__dirname, '.env');

function loadJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  return loadJson(CONFIG_PATH, {});
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function readEnv() {
  const env = {};
  if (!fs.existsSync(ENV_PATH)) return env;

  const content = fs.readFileSync(ENV_PATH, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

function saveEnv(env) {
  const lines = [
    '# ── Wallet ────────────────────────────────────────────────────────────────────',
    `WALLET_PRIVATE_KEY=${env.WALLET_PRIVATE_KEY || ''}`,
    '',
    '# ── Solana RPC ─────────────────────────────────────────────────────────────────',
    `RPC_URL=${env.RPC_URL || ''}`,
    '',
    '# ── LLM Provider ──────────────────────────────────────────────────────────────',
    `LLM_PROVIDER=${env.LLM_PROVIDER || ''}`,
    `OPENROUTER_API_KEY=${env.OPENROUTER_API_KEY || ''}`,
    `LLM_BASE_URL=${env.LLM_BASE_URL || ''}`,
    `LLM_API_KEY=${env.LLM_API_KEY || ''}`,
    `LLM_MODEL=${env.LLM_MODEL || ''}`,
    '',
    '# ── API Keys ───────────────────────────────────────────────────────────────────',
    `HELIUS_API_KEY=${env.HELIUS_API_KEY || ''}`,
    `GMGN_ROUTE_KEY=${env.GMGN_ROUTE_KEY || ''}`,
    '',
    '# ── Telegram Notifications ─────────────────────────────────────────────────────',
    `TELEGRAM_BOT_TOKEN=${env.TELEGRAM_BOT_TOKEN || ''}`,
    `TELEGRAM_CHAT_ID=${env.TELEGRAM_CHAT_ID || ''}`,
    `TELEGRAM_ALLOWED_USER_IDS=${env.TELEGRAM_ALLOWED_USER_IDS || ''}`,
    '',
    '# ── Vault / Tabungan ──────────────────────────────────────────────────────────',
    `VAULT_WALLET=${env.VAULT_WALLET || ''}`,
    '',
    '# ── Misc ──────────────────────────────────────────────────────────────────────',
    `EXECUTION_MODE=${env.EXECUTION_MODE || ''}`,
    `DRY_RUN=${env.DRY_RUN || 'false'}`,
    `LOG_LEVEL=${env.LOG_LEVEL || 'info'}`,
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

function maskSecret(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function toBool(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function normalizeNumber(value, fallback = null) {
  if (value === '' || value == null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function buildStrategyOptions() {
  return listStrategies().map((strategy) => ({
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
  }));
}

export function readSetupSnapshot() {
  const config = loadConfig();
  const env = readEnv();
  const mode = resolveExecutionMode({ userConfig: config, env });

  const wallets = Array.isArray(config.wallets) ? config.wallets : [];
  const walletCount = wallets.length;
  const walletAllocation = wallets.reduce((sum, wallet) => sum + (Number(wallet.capital_pct) || 0), 0);
  const walletTopology = validateWalletTopology({ enabled: !!config.multiWalletEnabled, wallets });
  const missing = [];

  if (!env.WALLET_PRIVATE_KEY && !config.walletKey) missing.push('wallet');
  if (!env.RPC_URL && !config.rpcUrl) missing.push('rpc');
  if (!env.LLM_PROVIDER && !config.llmProvider) missing.push('llm');
  if (config.confirmMode && !env.TELEGRAM_CHAT_ID) missing.push('telegram');

  return {
    mode: mode.mode,
    modeLabel: mode.label,
    activeStrategyId: getActiveStrategyId(),
    strategyOptions: buildStrategyOptions(),
    config: {
      executionMode: config.executionMode ?? mode.mode,
      dryRun: config.dryRun ?? mode.legacyDryRun,
      confirmMode: config.confirmMode ?? false,
      dailyReportEnabled: config.dailyReportEnabled ?? true,
      automationEnabled: config.automationEnabled ?? true,
      multiWalletEnabled: config.multiWalletEnabled ?? false,
      multiWalletMaxErrors: config.multiWalletMaxErrors ?? 3,
      multiWalletCooldownMin: config.multiWalletCooldownMin ?? 10,
      multiWalletAutoSpreadEnabled: config.multiWalletAutoSpreadEnabled ?? true,
      multiWalletAutoSpreadMinTotalSol: config.multiWalletAutoSpreadMinTotalSol ?? 3,
      multiWalletMinWalletDeploySol: config.multiWalletMinWalletDeploySol ?? 0.25,
      multiWalletMaxWalletsPerBatch: config.multiWalletMaxWalletsPerBatch ?? 2,
      maxPositions: config.maxPositions ?? 3,
      stopLossPct: config.stopLossPct ?? -15,
      dailyTargetPct: config.dailyTargetPct ?? 25,
      pilotCapitalUsd: config.pilotCapitalUsd ?? 10,
      strategy: config.strategy ?? getActiveStrategyId(),
      wallets,
    },
    env: {
      walletKeyConfigured: !!(env.WALLET_PRIVATE_KEY || config.walletKey),
      walletKeyPreview: maskSecret(env.WALLET_PRIVATE_KEY || config.walletKey),
      rpcUrl: env.RPC_URL || config.rpcUrl || 'https://pump.helius-rpc.com',
      llmProvider: env.LLM_PROVIDER || config.llmProvider || 'openrouter',
      llmModel: env.LLM_MODEL || config.llmModel || 'minimax/minimax-m2.7',
      llmBaseUrl: env.LLM_BASE_URL || config.llmBaseUrl || '',
      llmApiKeyConfigured: !!(env.LLM_API_KEY || config.llmApiKey),
      openrouterApiKeyConfigured: !!env.OPENROUTER_API_KEY,
      heliusApiKeyConfigured: !!env.HELIUS_API_KEY,
      gmgnRouteKeyConfigured: !!env.GMGN_ROUTE_KEY,
      telegramBotTokenConfigured: !!env.TELEGRAM_BOT_TOKEN,
      telegramChatId: env.TELEGRAM_CHAT_ID || '',
      telegramAllowedUserIds: env.TELEGRAM_ALLOWED_USER_IDS || '',
      vaultWalletConfigured: !!(env.VAULT_WALLET || config.vaultWallet),
      executionMode: env.EXECUTION_MODE || config.executionMode || mode.mode,
      dryRun: env.DRY_RUN || String(mode.legacyDryRun),
    },
    readiness: {
      missing,
      walletCount,
      walletAllocation,
      readyForLaunch: missing.length === 0 && walletTopology.ok,
      walletTopology,
    },
    updatedAt: new Date().toISOString(),
  };
}

function mergeDefined(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    target[key] = value;
  }
  return target;
}

export function applySetupDraft(draft = {}) {
  const config = loadConfig();
  const env = readEnv();
  const nextConfig = { ...config };
  const nextEnv = { ...env };
  const strategyId = typeof draft.strategyId === 'string' && draft.strategyId.trim() ? draft.strategyId.trim() : null;

  if (draft.mode === 'demo' || draft.mode === 'live') {
    nextConfig.executionMode = draft.mode;
    nextConfig.dryRun = draft.mode === 'demo';
    nextEnv.EXECUTION_MODE = draft.mode;
    nextEnv.DRY_RUN = String(draft.mode === 'demo');
  }

  mergeDefined(nextConfig, {
    confirmMode: typeof draft.confirmMode === 'boolean' ? draft.confirmMode : undefined,
    dailyReportEnabled: typeof draft.dailyReportEnabled === 'boolean' ? draft.dailyReportEnabled : undefined,
    automationEnabled: typeof draft.automationEnabled === 'boolean' ? draft.automationEnabled : undefined,
    multiWalletEnabled: typeof draft.multiWalletEnabled === 'boolean' ? draft.multiWalletEnabled : undefined,
    multiWalletMaxErrors: normalizeNumber(draft.multiWalletMaxErrors, undefined),
    multiWalletCooldownMin: normalizeNumber(draft.multiWalletCooldownMin, undefined),
    multiWalletAutoSpreadEnabled: typeof draft.multiWalletAutoSpreadEnabled === 'boolean' ? draft.multiWalletAutoSpreadEnabled : undefined,
    multiWalletAutoSpreadMinTotalSol: normalizeNumber(draft.multiWalletAutoSpreadMinTotalSol, undefined),
    multiWalletMinWalletDeploySol: normalizeNumber(draft.multiWalletMinWalletDeploySol, undefined),
    multiWalletMaxWalletsPerBatch: normalizeNumber(draft.multiWalletMaxWalletsPerBatch, undefined),
    maxPositions: normalizeNumber(draft.maxPositions, undefined),
    stopLossPct: normalizeNumber(draft.stopLossPct, undefined),
    dailyTargetPct: normalizeNumber(draft.dailyTargetPct, undefined),
    pilotCapitalUsd: normalizeNumber(draft.pilotCapitalUsd, undefined),
    walletKey: typeof draft.walletKey === 'string' && draft.walletKey.trim() ? draft.walletKey.trim() : undefined,
    rpcUrl: typeof draft.rpcUrl === 'string' && draft.rpcUrl.trim() ? draft.rpcUrl.trim() : undefined,
    llmProvider: typeof draft.llmProvider === 'string' && draft.llmProvider.trim() ? draft.llmProvider.trim() : undefined,
    llmModel: typeof draft.llmModel === 'string' && draft.llmModel.trim() ? draft.llmModel.trim() : undefined,
    llmBaseUrl: typeof draft.llmBaseUrl === 'string' && draft.llmBaseUrl.trim() ? draft.llmBaseUrl.trim() : undefined,
    llmApiKey: typeof draft.llmApiKey === 'string' && draft.llmApiKey.trim() ? draft.llmApiKey.trim() : undefined,
    strategy: strategyId || undefined,
    vaultWallet: typeof draft.vaultWallet === 'string' && draft.vaultWallet.trim() ? draft.vaultWallet.trim() : undefined,
  });

  if (draft.wallets && Array.isArray(draft.wallets)) {
    nextConfig.wallets = draft.wallets
      .map((wallet) => ({
        label: String(wallet.label || '').trim(),
        key: String(wallet.key || '').trim(),
        capital_pct: normalizeNumber(wallet.capital_pct, 0),
      }))
      .filter((wallet) => wallet.label || wallet.key);
  }

  const walletTopology = validateWalletTopology({
    enabled: !!nextConfig.multiWalletEnabled,
    wallets: nextConfig.wallets || [],
  });
  if (nextConfig.multiWalletEnabled && !walletTopology.ok) {
    const error = new Error(`Invalid multi-wallet topology: ${walletTopology.errors.join(" ")}`);
    error.walletTopology = walletTopology;
    throw error;
  }

  if (typeof draft.walletKey === 'string' && draft.walletKey.trim()) nextEnv.WALLET_PRIVATE_KEY = draft.walletKey.trim();
  if (typeof draft.rpcUrl === 'string' && draft.rpcUrl.trim()) nextEnv.RPC_URL = draft.rpcUrl.trim();
  if (typeof draft.llmProvider === 'string' && draft.llmProvider.trim()) nextEnv.LLM_PROVIDER = draft.llmProvider.trim();
  if (typeof draft.llmModel === 'string' && draft.llmModel.trim()) nextEnv.LLM_MODEL = draft.llmModel.trim();
  if (typeof draft.llmBaseUrl === 'string' && draft.llmBaseUrl.trim()) nextEnv.LLM_BASE_URL = draft.llmBaseUrl.trim();
  if (typeof draft.llmApiKey === 'string' && draft.llmApiKey.trim()) nextEnv.LLM_API_KEY = draft.llmApiKey.trim();
  if (typeof draft.openrouterApiKey === 'string' && draft.openrouterApiKey.trim()) nextEnv.OPENROUTER_API_KEY = draft.openrouterApiKey.trim();
  if (typeof draft.heliusApiKey === 'string' && draft.heliusApiKey.trim()) nextEnv.HELIUS_API_KEY = draft.heliusApiKey.trim();
  if (typeof draft.gmgnRouteKey === 'string' && draft.gmgnRouteKey.trim()) nextEnv.GMGN_ROUTE_KEY = draft.gmgnRouteKey.trim();
  if (typeof draft.telegramBotToken === 'string' && draft.telegramBotToken.trim()) nextEnv.TELEGRAM_BOT_TOKEN = draft.telegramBotToken.trim();
  if (typeof draft.telegramChatId === 'string' && draft.telegramChatId.trim()) nextEnv.TELEGRAM_CHAT_ID = draft.telegramChatId.trim();
  if (typeof draft.telegramAllowedUserIds === 'string' && draft.telegramAllowedUserIds.trim()) nextEnv.TELEGRAM_ALLOWED_USER_IDS = draft.telegramAllowedUserIds.trim();
  if (typeof draft.vaultWallet === 'string' && draft.vaultWallet.trim()) nextEnv.VAULT_WALLET = draft.vaultWallet.trim();
  if (draft.mode === 'demo' || draft.mode === 'live') nextEnv.EXECUTION_MODE = draft.mode;
  if (draft.mode === 'demo' || draft.mode === 'live') nextEnv.DRY_RUN = String(draft.mode === 'demo');

  saveConfig(nextConfig);
  saveEnv(nextEnv);

  return readSetupSnapshot();
}
