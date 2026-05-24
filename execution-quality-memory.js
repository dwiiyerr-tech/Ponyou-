import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXEC_FILE = path.join(__dirname, "execution-quality.json");
const DECAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadStore() {
  if (!fs.existsSync(EXEC_FILE)) return { routes: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(EXEC_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { routes: {} };
  } catch {
    return { routes: {} };
  }
}

function saveStore(data) {
  atomicWriteJson(EXEC_FILE, data);
}

function buildExecutionKey({
  walletAddress = "unknown",
  provider = "unknown",
  mode = "unknown",
  split = false,
  marketCondition = "UNKNOWN",
} = {}) {
  return [walletAddress, provider, mode, split ? "split" : "single", marketCondition].join("|");
}

function getOrCreateRoute(store, meta = {}) {
  const key = buildExecutionKey(meta);
  if (!store.routes[key]) {
    store.routes[key] = {
      key,
      wallet_address: meta.walletAddress || "unknown",
      provider: meta.provider || "unknown",
      mode: meta.mode || "unknown",
      split: !!meta.split,
      market_condition: meta.marketCondition || "UNKNOWN",
      attempts: 0,
      successes: 0,
      failures: 0,
      cumulative_latency_ms: 0,
      cumulative_slippage: 0,
      cumulative_quality_delta: 0,
      last_seen_at: null,
    };
  }
  return store.routes[key];
}

function decayRoute(route = {}, nowMs = Date.now()) {
  const lastSeen = route.last_seen_at ? new Date(route.last_seen_at).getTime() : 0;
  if (!lastSeen || nowMs <= lastSeen) return { ...route, decay_factor: 1 };
  const windows = (nowMs - lastSeen) / DECAY_WINDOW_MS;
  const decayFactor = Math.pow(0.9, windows);
  return {
    ...route,
    cumulative_latency_ms: Number((Number(route.cumulative_latency_ms || 0) * decayFactor).toFixed(4)),
    cumulative_slippage: Number((Number(route.cumulative_slippage || 0) * decayFactor).toFixed(4)),
    cumulative_quality_delta: Number((Number(route.cumulative_quality_delta || 0) * decayFactor).toFixed(4)),
    decay_factor: Number(decayFactor.toFixed(4)),
  };
}

export function buildExecutionContext({
  walletAddress = null,
  provider = null,
  mode = null,
  split = false,
  marketCondition = "UNKNOWN",
  slippage = 0,
} = {}) {
  return {
    walletAddress: walletAddress || "unknown",
    provider: provider || "unknown",
    mode: mode || "unknown",
    split: !!split,
    marketCondition: marketCondition || "UNKNOWN",
    slippage: Number(slippage || 0),
  };
}

export async function recordExecutionQuality({
  walletAddress = null,
  provider = null,
  mode = null,
  split = false,
  marketCondition = "UNKNOWN",
  slippage = 0,
  success = false,
  latencyMs = 0,
} = {}) {
  return withFileLock(EXEC_FILE, async () => {
    const store = loadStore();
    const route = getOrCreateRoute(store, buildExecutionContext({
      walletAddress,
      provider,
      mode,
      split,
      marketCondition,
      slippage,
    }));

    route.attempts += 1;
    if (success) route.successes += 1;
    else route.failures += 1;
    route.cumulative_latency_ms += Number(latencyMs || 0);
    route.cumulative_slippage += Number(slippage || 0);
    route.cumulative_quality_delta += success ? 8 : -12;
    route.last_seen_at = new Date().toISOString();
    saveStore(store);
    return route;
  });
}

export function getExecutionQualityAssessment({
  walletAddress = null,
  provider = null,
  mode = null,
  split = false,
  marketCondition = "UNKNOWN",
  slippage = 0,
  nowMs = Date.now(),
} = {}) {
  const store = loadStore();
  const key = buildExecutionKey(buildExecutionContext({
    walletAddress,
    provider,
    mode,
    split,
    marketCondition,
    slippage,
  }));
  const raw = store.routes[key];
  if (!raw) {
    return {
      key,
      quality_score: 50,
      confidence_score: 0,
      success_rate: 0,
      stance: "unknown",
      size_multiplier: 1,
    };
  }

  const route = decayRoute(raw, nowMs);
  const attempts = Math.max(0, route.attempts || 0);
  const successRate = attempts > 0 ? (route.successes || 0) / attempts : 0;
  const avgLatency = attempts > 0 ? route.cumulative_latency_ms / attempts : 0;
  const avgSlippage = attempts > 0 ? route.cumulative_slippage / attempts : 0;

  const qualityScore = clamp(
    50 +
    (successRate - 0.5) * 45 +
    Number(route.cumulative_quality_delta || 0) -
    Math.min(12, avgSlippage * 3) -
    Math.min(10, avgLatency / 2000),
    0,
    100
  );
  const confidenceScore = clamp(attempts * 18, 0, 100);

  let stance = "unknown";
  let sizeMultiplier = 1;
  if (confidenceScore < 18) {
    stance = "unknown";
  } else if (qualityScore >= 65) {
    stance = "preferred";
    sizeMultiplier = 1.05;
  } else if (qualityScore < 35) {
    stance = "avoid";
    sizeMultiplier = 0.75;
  } else {
    stance = "neutral";
  }

  return {
    key,
    quality_score: Number(qualityScore.toFixed(1)),
    confidence_score: Number(confidenceScore.toFixed(1)),
    success_rate: Number(successRate.toFixed(3)),
    avg_latency_ms: Number(avgLatency.toFixed(1)),
    avg_slippage: Number(avgSlippage.toFixed(3)),
    attempts,
    decay_factor: route.decay_factor,
    stance,
    size_multiplier: Number(sizeMultiplier.toFixed(2)),
  };
}

export function rankWalletExecutionCandidates(wallets = [], context = {}) {
  return [...wallets]
    .map(wallet => ({
      ...wallet,
      execution_quality: getExecutionQualityAssessment({
        ...context,
        walletAddress: wallet.address,
      }),
    }))
    .sort((a, b) =>
      (b.execution_quality?.quality_score || 0) - (a.execution_quality?.quality_score || 0) ||
      (b.execution_quality?.confidence_score || 0) - (a.execution_quality?.confidence_score || 0)
    );
}

export function _resetExecutionQualityForTests() {
  if (fs.existsSync(EXEC_FILE)) fs.unlinkSync(EXEC_FILE);
}
