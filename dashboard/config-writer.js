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
  "menuEnabled", "logLevel",
  "screening", "execution", "filters",
  "blocklist", "watchlist", "wallets",
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
