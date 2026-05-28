import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson, withFileLock } from "./atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGIME_FILE = path.join(__dirname, "regime-memory.json");
const DECAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadStore() {
  if (!fs.existsSync(REGIME_FILE)) return { regimes: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(REGIME_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { regimes: {} };
  } catch {
    return { regimes: {} };
  }
}

function saveStore(data) {
  atomicWriteJson(REGIME_FILE, data);
}

function decaySlot(slot = {}, nowMs = Date.now()) {
  const lastSeen = slot.last_seen_at ? new Date(slot.last_seen_at).getTime() : 0;
  if (!lastSeen || nowMs <= lastSeen) return { ...slot, decay_factor: 1 };
  const windows = (nowMs - lastSeen) / DECAY_WINDOW_MS;
  const decayFactor = Math.pow(0.9, windows);
  return {
    ...slot,
    cumulative_signal_score: Number((Number(slot.cumulative_signal_score || 0) * decayFactor).toFixed(4)),
    cumulative_outcome_delta: Number((Number(slot.cumulative_outcome_delta || 0) * decayFactor).toFixed(4)),
    decay_factor: Number(decayFactor.toFixed(4)),
  };
}

function buildRegimeKey({
  marketCondition = "UNKNOWN",
  tier = "UNKNOWN",
  narrative = "OTHER",
  verdict = "watch",
} = {}) {
  return [marketCondition, tier, narrative, verdict].join("|");
}

function normalizeNarrative(token = {}) {
  if (token.conviction?.narrative_cluster?.narrative) return token.conviction.narrative_cluster.narrative;
  if (Array.isArray(token.narrative_tags) && token.narrative_tags.length > 0) {
    const first = token.narrative_tags[0];
    return typeof first === "string" ? first : first?.narrative || "OTHER";
  }
  return "OTHER";
}

function normalizeTier(token = {}) {
  return token.tier_execution?.tier || token.tier?.label || token.tier?.tier || "UNKNOWN";
}

function getOrCreateRegime(store, key, meta = {}) {
  if (!store.regimes[key]) {
    store.regimes[key] = {
      key,
      market_condition: meta.marketCondition || "UNKNOWN",
      tier: meta.tier || "UNKNOWN",
      narrative: meta.narrative || "OTHER",
      verdict: meta.verdict || "watch",
      observation_count: 0,
      trade_count: 0,
      win_count: 0,
      loss_count: 0,
      cumulative_signal_score: 0,
      cumulative_outcome_delta: 0,
      last_seen_at: null,
    };
  }
  return store.regimes[key];
}

export function buildTokenRegime(token = {}) {
  const marketCondition = token.market_condition || "UNKNOWN";
  const tier = normalizeTier(token);
  const narrative = normalizeNarrative(token);
  const verdict = token.workflow?.verdict || "watch";
  return {
    marketCondition,
    tier,
    narrative,
    verdict,
    key: buildRegimeKey({ marketCondition, tier, narrative, verdict }),
  };
}

export async function recordRegimeObservation(token = {}, { nowMs = Date.now() } = {}) {
  if (!token?.mint) return null;
  return withFileLock(REGIME_FILE, async () => {
    const store = loadStore();
    const regime = buildTokenRegime(token);
    const slot = getOrCreateRegime(store, regime.key, regime);
    slot.observation_count += 1;
    slot.cumulative_signal_score += Number(token.conviction?.conviction_score || token.avg_signal_score || 0);
    slot.last_seen_at = new Date(nowMs).toISOString();
    saveStore(store);
    return slot;
  });
}

export async function recordRegimeTradeOutcome({
  marketCondition = "UNKNOWN",
  tier = "UNKNOWN",
  narrative = "OTHER",
  // RGM-5: align with recordRegimeObservation's default ("watch") so a
  // token that wasn't explicitly verdict-tagged at observation time
  // updates the SAME regime slot when it later closes a trade. Before
  // this, the default mismatch ("watch" obs vs "active" trade) split
  // stats across two keys and the regime win-rate math was broken.
  verdict = "watch",
  pnl_pct = 0,
  nowMs = Date.now(),
} = {}) {
  return withFileLock(REGIME_FILE, async () => {
    const store = loadStore();
    const key = buildRegimeKey({ marketCondition, tier, narrative, verdict });
    const slot = getOrCreateRegime(store, key, { marketCondition, tier, narrative, verdict });
    slot.trade_count += 1;
    if (Number(pnl_pct || 0) > 0) slot.win_count += 1;
    else slot.loss_count += 1;
    slot.cumulative_outcome_delta += Number(pnl_pct || 0) > 0
      ? Math.min(18, Math.max(4, Number(pnl_pct || 0) / 4))
      : -Math.min(18, Math.max(4, Math.abs(Number(pnl_pct || 0)) / 4));
    slot.last_seen_at = new Date(nowMs).toISOString();
    saveStore(store);
    return slot;
  });
}

export function getRegimeAssessment(token = {}, { nowMs = Date.now() } = {}) {
  const store = loadStore();
  const regime = buildTokenRegime(token);
  const slot = store.regimes[regime.key];
  if (!slot) {
    return {
      ...regime,
      confidence_score: 0,
      regime_score: 0,
      stance: "unknown",
      size_multiplier: 1,
    };
  }

  const decayed = decaySlot(slot, nowMs);
  const observations = Math.max(0, decayed.observation_count || 0);
  const trades = Math.max(0, decayed.trade_count || 0);
  const avgSignal = observations > 0 ? decayed.cumulative_signal_score / observations : 0;
  const winRate = trades > 0 ? (decayed.win_count || 0) / trades : 0;
  const score = clamp(
    avgSignal * 0.35 +
    Number(decayed.cumulative_outcome_delta || 0) +
    (winRate - 0.5) * 24,
    0,
    100
  );
  const confidence = clamp(observations * 7 + trades * 14, 0, 100);

  let stance = "watch";
  let sizeMultiplier = 1;
  if (confidence < 20) {
    stance = "unknown";
  } else if (score >= 58 && confidence >= 35) {
    stance = "tailwind";
    sizeMultiplier = 1.15;
  } else if (score < 28) {
    stance = "avoid";
    sizeMultiplier = 0.4;
  } else if (score < 45) {
    stance = "cautious";
    sizeMultiplier = 0.75;
  }

  return {
    ...regime,
    confidence_score: Number(confidence.toFixed(1)),
    regime_score: Number(score.toFixed(1)),
    win_rate: Number(winRate.toFixed(3)),
    observation_count: observations,
    trade_count: trades,
    decay_factor: decayed.decay_factor,
    stance,
    size_multiplier: Number(sizeMultiplier.toFixed(2)),
  };
}

export function getRegimePromptLine(token = {}) {
  const regime = getRegimeAssessment(token);
  return `Regime: ${regime.marketCondition}/${regime.tier}/${regime.narrative}/${regime.verdict} | stance=${regime.stance} | score=${regime.regime_score} | confidence=${regime.confidence_score}`;
}

export function _resetRegimeMemoryForTests() {
  if (fs.existsSync(REGIME_FILE)) fs.unlinkSync(REGIME_FILE);
}
