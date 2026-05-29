import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let BASE_PATH = path.join(__dirname, "..");

export function _setBasePath(p) { BASE_PATH = p; }

function cfgPath() { return path.join(BASE_PATH, "user-config.json"); }

export function maskPrivateKey(key) {
  if (!key || typeof key !== "string" || key.length < 8) return key || "";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function readConfig() {
  try {
    if (!fs.existsSync(cfgPath())) return {};
    const raw = JSON.parse(fs.readFileSync(cfgPath(), "utf8"));
    if (raw.privateKey) raw.privateKey = maskPrivateKey(raw.privateKey);
    return raw;
  } catch { return {}; }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const ALLOWED_KEYS = new Set([
  "preset", "rpcUrl", "rpcUrls", "rpcMode", "shyftApiKey",
  "geyserGrpcUrl", "geyserGrpcToken",
  "walletAddress", "privateKey",
  "telegramBotToken", "telegramChatId",
  "executionMode", "dryRun",
  "llmEnabled", "llmProvider", "llmModel", "llmApiKey", "llmBaseUrl", "llmTemperature",
  "managementModel", "screeningModel", "generalModel",
  "customProviders",
  "deployAmountSol", "maxPositions", "minSolToOpen", "maxDeployAmount",
  "gasReserve", "positionSizePct",
  "strategy", "confirmMode", "confirmTtlMin",
  "timeframe", "category", "excludeHighSupplyConcentration",
  "minTvl", "maxTvl", "minVolume", "minOrganic", "minQuoteOrganic",
  "minHolders", "minMcap", "maxMcap", "minTokenFeesSol",
  "useDiscordSignals", "discordSignalMode",
  "avoidPvpSymbols", "blockPvpSymbols",
  "maxBundlePct", "maxBotHoldersPct", "maxTop10Pct",
  "allowedLaunchpads", "blockedLaunchpads",
  "minTokenAgeHours", "maxTokenAgeHours", "athFilterPct",
  "minClaimAmount", "autoSwapAfterClaim",
  "stopLossPct", "takeProfitPct",
  "trailingTakeProfit", "trailingTriggerPct", "trailingDropPct",
  "pnlSanityMaxDiffPct", "solMode",
  "managementIntervalMin", "screeningIntervalMin", "healthCheckIntervalMin",
  "temperature", "maxTokens", "maxSteps",
  "darwinEnabled", "darwinFastMode",
  "darwinWindowDays", "darwinRecalcEvery", "darwinBoost", "darwinDecay",
  "darwinFloor", "darwinCeiling", "darwinMinSamples",
  "chartIndicators",
  "killSwitchDailyLossSol", "killSwitchDrawdownPct",
  "partialTPEnabled", "partialTPThreshold", "partialTPFraction",
  "kellyFractionCap", "maxDailyTrades", "maxOpenPositions",
  "stateRetentionDays", "cooldownMinutes",
  "dashboardEnabled", "dashboardPort",
  "narrativeFilterEnabled", "rugFilterEnabled", "smartWalletFilterEnabled",
  "trashFilterEnabled", "devBlacklistEnabled", "rugCheckEnabled",
  "sellSimEnabled", "rugAnomalyEnabled", "rugLLMEnabled",
  "dayPhaseScreenerEnabled",
  "stagedEntryEnabled", "stagedEntryStages", "stagedEntryTrigger",
  "strategyEvolutionEnabled", "runtimeSelectorMode",
  "menuEnabled", "logLevel",
  "screening", "execution", "filters",
  "blocklist", "watchlist", "wallets", "trashWallets",
  "hunter", "copyTrade", "positionLimits",
  "vault", "tradingPlan", "dailyTradeGuard",
]);

const URL_KEYS = new Set(["rpcUrl", "geyserGrpcUrl", "llmBaseUrl"]);

function isSafeHttpUrl(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

function sanitizeCustomProviders(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 64) continue;
    if (!isSafeHttpUrl(p.baseUrl)) continue;
    out.push(p);
  }
  return out;
}

function sanitizeRpcUrls(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isSafeHttpUrl).slice(0, 16);
}

const WALLET_LABEL_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const WALLET_ENV_REF_PATTERN = /^WALLET_KEY_(?:10|[1-9])$/;

function sanitizeWallets(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const w of arr) {
    if (out.length >= 10) break;
    if (!w || typeof w !== "object" || Array.isArray(w)) continue;
    const label = typeof w.label === "string" ? w.label.trim() : "";
    const envRef = typeof w.env_ref === "string" ? w.env_ref.trim() : "";
    const pct = Number(w.capital_pct);
    if (!WALLET_LABEL_PATTERN.test(label)) continue;
    if (!WALLET_ENV_REF_PATTERN.test(envRef)) continue;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) continue;
    // Strip key — wizard never persists plaintext to user-config.json.
    out.push({ label, env_ref: envRef, capital_pct: pct });
  }
  return out;
}

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function sanitizeTrashWallets(arr) {
  if (!Array.isArray(arr)) return [];
  // CW-1: dedup case-SENSITIVELY. Solana base58 addresses are case-sensitive;
  // "Aa..." and "aa..." are different on-chain accounts. Previously this
  // used toLowerCase() for dedup, which would collapse two legitimately
  // different addresses to one (lost entry) or wrongly preserve a
  // collision pair.
  const seen = new Set();
  const out = [];
  for (const entry of arr) {
    if (out.length >= 200) break;
    // Accept plain string address or {address, label} object
    let addr, label;
    if (typeof entry === "string") {
      addr = entry.trim();
      label = "";
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      addr = typeof entry.address === "string" ? entry.address.trim() : "";
      label = typeof entry.label === "string" ? entry.label.trim().slice(0, 64) : "";
    } else {
      continue;
    }
    if (!SOLANA_ADDRESS_RE.test(addr)) continue;
    if (seen.has(addr)) continue;     // case-sensitive
    seen.add(addr);
    out.push(label ? { address: addr, label } : { address: addr });
  }
  return out;
}

const VALID_HUNTER_SOURCES = new Set(["search", "pumpfun", "gainers", "newest", "geckoterminal", "smart_money", "jupiter"]);

function sanitizeHunter(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  if (Array.isArray(obj.sources)) {
    out.sources = [...new Set(obj.sources.filter(s => VALID_HUNTER_SOURCES.has(s)))];
  }
  if (typeof obj.minLiquidity === "number" && obj.minLiquidity >= 0) out.minLiquidity = obj.minLiquidity;
  if (typeof obj.minSwaps === "number" && obj.minSwaps >= 0) out.minSwaps = obj.minSwaps;
  if (typeof obj.minMcap === "number" && obj.minMcap >= 0) out.minMcap = obj.minMcap;
  if (typeof obj.maxAgeHours === "number" && obj.maxAgeHours > 0) out.maxAgeHours = obj.maxAgeHours;
  if (typeof obj.minAgeMinutes === "number" && obj.minAgeMinutes >= 0) out.minAgeMinutes = obj.minAgeMinutes;
  if (Array.isArray(obj.customQueries)) {
    out.customQueries = obj.customQueries
      .filter(q => typeof q === "string" && q.length > 0 && q.length <= 50)
      .slice(0, 30);
  }
  return out;
}

function sanitizeCopyTrade(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  const validModes = new Set(["signal_only", "confirm_copy", "auto_copy"]);
  if (typeof obj.mode === "string" && validModes.has(obj.mode)) out.mode = obj.mode;
  if (typeof obj.maxCopySol === "number" && obj.maxCopySol >= 0.01 && obj.maxCopySol <= 100) out.maxCopySol = obj.maxCopySol;
  if (typeof obj.minWalletWinRate === "number" && obj.minWalletWinRate >= 0 && obj.minWalletWinRate <= 1) out.minWalletWinRate = obj.minWalletWinRate;
  if (typeof obj.maxSlippagePct === "number" && obj.maxSlippagePct >= 0 && obj.maxSlippagePct <= 100) out.maxSlippagePct = obj.maxSlippagePct;
  if (typeof obj.cooldownMinutes === "number" && obj.cooldownMinutes >= 0) out.cooldownMinutes = obj.cooldownMinutes;
  if (typeof obj.maxCopyPerDay === "number" && obj.maxCopyPerDay >= 0) out.maxCopyPerDay = obj.maxCopyPerDay;
  if (typeof obj.requireMultiWallet === "boolean") out.requireMultiWallet = obj.requireMultiWallet;
  return out;
}

const VALID_STRATEGY_IDS = new Set(["scalp", "sniper", "dip_buy", "conservative", "aggressive", "recovery", "day_phase_swing"]);

function sanitizePositionLimits(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  if (obj.mode === "manual" || obj.mode === "kelly") out.mode = obj.mode;
  if (typeof obj.kellyFraction === "number" && obj.kellyFraction >= 0.1 && obj.kellyFraction <= 1) out.kellyFraction = obj.kellyFraction;
  if (obj.perStrategy && typeof obj.perStrategy === "object" && !Array.isArray(obj.perStrategy)) {
    out.perStrategy = {};
    for (const [id, entry] of Object.entries(obj.perStrategy)) {
      if (!VALID_STRATEGY_IDS.has(id)) continue;
      // Support both legacy number and new object format
      if (typeof entry === "number") {
        const n = Number(entry);
        if (Number.isFinite(n) && n >= 1 && n <= 20) {
          out.perStrategy[id] = { maxPositions: Math.round(n), minSolToActivate: 0.5, maxPerCoin: 1 };
        }
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const cfg = {};
        const mp = Number(entry.maxPositions);
        if (Number.isFinite(mp) && mp >= 1 && mp <= 20) cfg.maxPositions = Math.round(mp);
        else continue;
        const ms = Number(entry.minSolToActivate);
        cfg.minSolToActivate = Number.isFinite(ms) && ms >= 0 ? ms : 0.5;
        const mc = Number(entry.maxPerCoin);
        cfg.maxPerCoin = Number.isFinite(mc) && mc >= 1 && mc <= 10 ? Math.round(mc) : 1;
        out.perStrategy[id] = cfg;
      }
    }
  }
  return out;
}

function sanitizeConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (!ALLOWED_KEYS.has(k)) continue;
    if (URL_KEYS.has(k)) {
      if (!isSafeHttpUrl(v)) continue;
      out[k] = v;
      continue;
    }
    if (k === "rpcUrls") { out[k] = sanitizeRpcUrls(v); continue; }
    if (k === "customProviders") { out[k] = sanitizeCustomProviders(v); continue; }
    if (k === "wallets") { out[k] = sanitizeWallets(v); continue; }
    if (k === "trashWallets") { out[k] = sanitizeTrashWallets(v); continue; }
    if (k === "hunter") { out[k] = sanitizeHunter(v); continue; }
    if (k === "copyTrade") { out[k] = sanitizeCopyTrade(v); continue; }
    if (k === "positionLimits") { out[k] = sanitizePositionLimits(v); continue; }
    out[k] = v;
  }
  return out;
}

export function writeConfig(data) {
  const safe = sanitizeConfig(data);
  if (safe.privateKey && typeof safe.privateKey === "string" && /…/.test(safe.privateKey)) delete safe.privateKey;
  let existing = {};
  try {
    if (fs.existsSync(cfgPath())) existing = JSON.parse(fs.readFileSync(cfgPath(), "utf8"));
  } catch {}
  const merged = { ...existing, ...safe };
  atomicWriteJson(cfgPath(), merged);
}
