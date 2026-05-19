import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { classifyNarrative } from "./tools/narratives.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONVICTION_FILE = path.join(__dirname, "coin-conviction.json");
const DECAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadStore() {
  if (!fs.existsSync(CONVICTION_FILE)) return { coins: {}, narratives: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONVICTION_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return { coins: {}, narratives: {} };
    return {
      coins: parsed.coins && typeof parsed.coins === "object" ? parsed.coins : {},
      narratives: parsed.narratives && typeof parsed.narratives === "object" ? parsed.narratives : {},
    };
  } catch {
    return { coins: {}, narratives: {} };
  }
}

function saveStore(data) {
  fs.writeFileSync(CONVICTION_FILE, JSON.stringify(data, null, 2));
}

function getOrCreateCoin(store, mint, symbol = null) {
  if (!store.coins[mint]) {
    store.coins[mint] = {
      mint,
      symbol: symbol || mint.slice(0, 8),
      observation_count: 0,
      passed_count: 0,
      failed_count: 0,
      gem_count: 0,
      trash_count: 0,
      rug_count: 0,
      win_count: 0,
      loss_count: 0,
      cumulative_signal_score: 0,
      cumulative_outcome_delta: 0,
      last_signal_score: 0,
      last_seen_at: null,
      last_market_condition: "UNKNOWN",
      narratives: [],
    };
  }
  if (symbol) store.coins[mint].symbol = symbol;
  return store.coins[mint];
}

function getOrCreateNarrative(store, narrative) {
  if (!store.narratives[narrative]) {
    store.narratives[narrative] = {
      narrative,
      observation_count: 0,
      gem_count: 0,
      trash_count: 0,
      rug_count: 0,
      win_count: 0,
      loss_count: 0,
      cumulative_signal_score: 0,
      cumulative_outcome_delta: 0,
      last_seen_at: null,
    };
  }
  return store.narratives[narrative];
}

function extractNarrativeNames(token = {}) {
  const explicit = Array.isArray(token.narrative_tags) ? token.narrative_tags : [];
  const normalizedExplicit = explicit
    .map(tag => typeof tag === "string" ? tag : tag?.narrative)
    .filter(Boolean);
  if (normalizedExplicit.length > 0) {
    return [...new Set(normalizedExplicit.filter(tag => tag !== "OTHER"))];
  }
  const classified = classifyNarrative(token);
  return [...new Set((classified || []).map(tag => tag?.narrative).filter(tag => tag && tag !== "OTHER"))];
}

function applyDecay(entity = {}, now = Date.now()) {
  const lastSeen = entity.last_seen_at ? new Date(entity.last_seen_at).getTime() : 0;
  if (!lastSeen || now <= lastSeen) return { ...entity, decay_factor: 1 };
  const ageMs = now - lastSeen;
  const windows = ageMs / DECAY_WINDOW_MS;
  const decayFactor = Math.pow(0.88, windows);
  return {
    ...entity,
    cumulative_outcome_delta: Number((Number(entity.cumulative_outcome_delta || 0) * decayFactor).toFixed(4)),
    cumulative_signal_score: Number((Number(entity.cumulative_signal_score || 0) * Math.max(0.92, decayFactor)).toFixed(4)),
    decay_factor: Number(decayFactor.toFixed(4)),
  };
}

export function deriveSignalScore(token = {}) {
  let score = 50;
  if (token.passed) score += 12;
  score -= Math.min(30, Number(token.rug_score || 0) * 0.5);
  score -= Math.min(20, (token.flags || []).length * 6);
  score += Math.max(-10, Math.min(15, Number(token.momentum_score || 0) / 8));

  if (token.kelly?.should_skip) score -= 25;
  else score += Math.min(12, Math.max(0, Number(token.kelly?.effective_fraction || 0) * 40));

  if (token.market_condition === "HOT") score += 6;
  if (token.market_condition === "COLD") score -= 4;
  if (token.market_condition === "DEAD") score -= 12;

  return clamp(Number(score.toFixed(2)), 0, 100);
}

export function recordCoinObservation(token = {}, { minIntervalMs = 30 * 60 * 1000 } = {}) {
  if (!token?.mint) return null;
  const store = loadStore();
  const coin = getOrCreateCoin(store, token.mint, token.symbol);
  const now = Date.now();
  const lastSeen = coin.last_seen_at ? new Date(coin.last_seen_at).getTime() : 0;
  if (lastSeen && now - lastSeen < minIntervalMs) return coin;

  const signalScore = deriveSignalScore(token);
  const narratives = extractNarrativeNames(token);
  coin.observation_count += 1;
  if (token.passed) coin.passed_count += 1;
  else coin.failed_count += 1;
  coin.cumulative_signal_score += signalScore;
  coin.last_signal_score = signalScore;
  coin.last_seen_at = new Date(now).toISOString();
  coin.last_market_condition = token.market_condition || coin.last_market_condition || "UNKNOWN";
  coin.narratives = narratives;

  for (const narrative of narratives) {
    const slot = getOrCreateNarrative(store, narrative);
    slot.observation_count += 1;
    slot.cumulative_signal_score += signalScore;
    slot.last_seen_at = new Date(now).toISOString();
  }

  saveStore(store);
  return coin;
}

export function recordObservationOutcomes(results = []) {
  if (!Array.isArray(results) || results.length === 0) return 0;
  const store = loadStore();
  let changed = 0;

  for (const result of results) {
    if (!result?.mint) continue;
    const coin = getOrCreateCoin(store, result.mint, result.symbol);
    const narratives = coin.narratives || extractNarrativeNames(result);
    if (result.performance === "GEM") {
      coin.gem_count += 1;
      coin.cumulative_outcome_delta += 18;
    } else if (result.performance === "TRASH") {
      coin.trash_count += 1;
      coin.cumulative_outcome_delta -= 14;
    } else if (result.performance === "RUG") {
      coin.rug_count += 1;
      coin.cumulative_outcome_delta -= 28;
    }
    for (const narrative of narratives) {
      const slot = getOrCreateNarrative(store, narrative);
      if (result.performance === "GEM") {
        slot.gem_count += 1;
        slot.cumulative_outcome_delta += 12;
      } else if (result.performance === "TRASH") {
        slot.trash_count += 1;
        slot.cumulative_outcome_delta -= 10;
      } else if (result.performance === "RUG") {
        slot.rug_count += 1;
        slot.cumulative_outcome_delta -= 18;
      }
      slot.last_seen_at = new Date().toISOString();
    }
    changed += 1;
  }

  if (changed > 0) saveStore(store);
  return changed;
}

export function recordTradeConvictionOutcome({ mint, symbol, pnl_pct = 0, exit_reason = "" } = {}) {
  if (!mint) return null;
  const store = loadStore();
  const coin = getOrCreateCoin(store, mint, symbol);
  const narratives = coin.narratives || [];
  const isWin = Number(pnl_pct || 0) > 0;
  if (isWin) {
    coin.win_count += 1;
    coin.cumulative_outcome_delta += Math.min(16, Math.max(6, Number(pnl_pct || 0) / 5));
  } else {
    coin.loss_count += 1;
    coin.cumulative_outcome_delta -= Math.min(18, Math.max(6, Math.abs(Number(pnl_pct || 0)) / 4));
  }
  if (/rug/i.test(exit_reason || "")) {
    coin.rug_count += 1;
    coin.cumulative_outcome_delta -= 10;
  }
  for (const narrative of narratives) {
    const slot = getOrCreateNarrative(store, narrative);
    if (isWin) {
      slot.win_count += 1;
      slot.cumulative_outcome_delta += Math.min(10, Math.max(4, Number(pnl_pct || 0) / 8));
    } else {
      slot.loss_count += 1;
      slot.cumulative_outcome_delta -= Math.min(12, Math.max(4, Math.abs(Number(pnl_pct || 0)) / 7));
    }
    if (/rug/i.test(exit_reason || "")) {
      slot.rug_count += 1;
      slot.cumulative_outcome_delta -= 8;
    }
    slot.last_seen_at = new Date().toISOString();
  }
  saveStore(store);
  return coin;
}

export function getNarrativeConviction(narrative, { nowMs = Date.now() } = {}) {
  if (!narrative) {
    return {
      narrative: null,
      conviction_score: 0,
      confidence_score: 0,
      stance: "unknown",
    };
  }

  const store = loadStore();
  const raw = store.narratives[narrative];
  if (!raw) {
    return {
      narrative,
      conviction_score: 0,
      confidence_score: 0,
      stance: "unknown",
    };
  }

  const slot = applyDecay(raw, nowMs);
  const obs = Math.max(0, slot.observation_count || 0);
  const avgSignal = obs > 0 ? slot.cumulative_signal_score / obs : 0;
  const convictionScore = clamp(
    10 + avgSignal * 0.42 + Number(slot.cumulative_outcome_delta || 0),
    0,
    100
  );
  const confidenceScore = clamp(
    obs * 10 + ((slot.gem_count || 0) + (slot.trash_count || 0) + (slot.rug_count || 0) + (slot.win_count || 0) + (slot.loss_count || 0)) * 7,
    0,
    100
  );
  let stance = "watch";
  if (confidenceScore < 15) stance = "unknown";
  else if (convictionScore >= 68 && confidenceScore >= 40) stance = "strong";
  else if (convictionScore >= 48) stance = "building";
  else if (convictionScore < 28) stance = "avoid";

  return {
    narrative,
    conviction_score: Number(convictionScore.toFixed(1)),
    confidence_score: Number(confidenceScore.toFixed(1)),
    observation_count: obs,
    gem_count: slot.gem_count || 0,
    trash_count: slot.trash_count || 0,
    rug_count: slot.rug_count || 0,
    win_count: slot.win_count || 0,
    loss_count: slot.loss_count || 0,
    avg_signal_score: Number(avgSignal.toFixed(1)),
    decay_factor: slot.decay_factor,
    stance,
  };
}

export function getCoinConviction(mint, token = null, { nowMs = Date.now() } = {}) {
  if (!mint) {
    return {
      mint: null,
      conviction_score: 0,
      confidence_score: 0,
      observation_count: 0,
      gem_count: 0,
      trash_count: 0,
      win_count: 0,
      loss_count: 0,
      stance: "unknown",
    };
  }

  const store = loadStore();
  const coin = store.coins[mint];
  const narrativeNames = coin?.narratives?.length ? coin.narratives : extractNarrativeNames(token || {});
  const narrativeConvictions = narrativeNames.map(name => getNarrativeConviction(name, { nowMs }));
  const strongestNarrative = narrativeConvictions.sort((a, b) => b.conviction_score - a.conviction_score)[0] || null;
  if (!coin) {
    return {
      mint,
      conviction_score: strongestNarrative?.conviction_score || 0,
      confidence_score: strongestNarrative?.confidence_score || 0,
      observation_count: 0,
      gem_count: 0,
      trash_count: 0,
      win_count: 0,
      loss_count: 0,
      stance: strongestNarrative?.stance || "unknown",
      narratives: narrativeNames,
      narrative_cluster: strongestNarrative,
    };
  }

  const decayedCoin = applyDecay(coin, nowMs);
  const obs = Math.max(0, decayedCoin.observation_count || 0);
  const avgSignal = obs > 0 ? decayedCoin.cumulative_signal_score / obs : 0;
  const passRate = obs > 0 ? (decayedCoin.passed_count || 0) / obs : 0;
  let convictionScore = clamp(
    15 +
    avgSignal * 0.45 +
    (passRate - 0.5) * 18 +
    Number(decayedCoin.cumulative_outcome_delta || 0),
    0,
    100
  );
  let confidenceScore = clamp(
    obs * 12 +
    ((decayedCoin.gem_count || 0) + (decayedCoin.trash_count || 0) + (decayedCoin.rug_count || 0) + (decayedCoin.win_count || 0) + (decayedCoin.loss_count || 0)) * 8,
    0,
    100
  );
  if (strongestNarrative) {
    convictionScore = clamp(convictionScore * 0.75 + strongestNarrative.conviction_score * 0.25, 0, 100);
    confidenceScore = clamp(confidenceScore * 0.8 + strongestNarrative.confidence_score * 0.2, 0, 100);
  }

  let stance = "watch";
  if (confidenceScore < 20) stance = "unknown";
  else if (convictionScore >= 70 && confidenceScore >= 45) stance = "strong";
  else if (convictionScore >= 50) stance = "building";
  else if (convictionScore < 30) stance = "avoid";

  return {
    mint,
    symbol: coin.symbol,
    conviction_score: Number(convictionScore.toFixed(1)),
    confidence_score: Number(confidenceScore.toFixed(1)),
    observation_count: obs,
    gem_count: decayedCoin.gem_count || 0,
    trash_count: decayedCoin.trash_count || 0,
    rug_count: decayedCoin.rug_count || 0,
    win_count: decayedCoin.win_count || 0,
    loss_count: decayedCoin.loss_count || 0,
    avg_signal_score: Number(avgSignal.toFixed(1)),
    decay_factor: decayedCoin.decay_factor,
    narratives: narrativeNames,
    narrative_cluster: strongestNarrative,
    stance,
  };
}

export function getConvictionPromptLine(mint) {
  const conviction = getCoinConviction(mint);
  return `Conviction: ${conviction.stance} | score=${conviction.conviction_score} | confidence=${conviction.confidence_score} | obs=${conviction.observation_count}`;
}

export function _resetConvictionMemoryForTests() {
  if (fs.existsSync(CONVICTION_FILE)) fs.unlinkSync(CONVICTION_FILE);
}
