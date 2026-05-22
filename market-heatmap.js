import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMarketIntelligence } from "./market-intelligence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, "market-heatmap-state.json");

const REGIME_MAX_POSITIONS = {
  FRENZY:  5,
  HOT:     4,
  NORMAL:  3,
  COLD:    2,
  DEAD:    1,
};

const STALE_MS = 10 * 60 * 1000; // 10 min — treat as NORMAL if stale

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Map market-intelligence condition to heatmap regime.
 * EXTREME → FRENZY (5 slots), else pass-through.
 */
export function computeMarketRegime() {
  const intel = getMarketIntelligence();
  const condition = intel?.condition ?? "NORMAL";
  const regime = condition === "EXTREME" ? "FRENZY" : (condition in REGIME_MAX_POSITIONS ? condition : "NORMAL");

  const state = {
    regime,
    condition,
    computed_at: Date.now(),
    max_positions: REGIME_MAX_POSITIONS[regime] ?? 3,
  };
  saveState(state);
  return state;
}

/**
 * Get current heatmap regime — uses cached state if fresh, else recomputes.
 */
export function getHeatmapRegime() {
  const state = loadState();
  if (state.computed_at && Date.now() - state.computed_at < STALE_MS) return state;
  return computeMarketRegime();
}

/**
 * Get dynamic maxPositions based on market regime.
 * Falls back to NORMAL (3) if stale or unavailable.
 */
export function getMaxPositions(fallback = 3) {
  try {
    const state = getHeatmapRegime();
    if (!state.computed_at || Date.now() - state.computed_at > STALE_MS) return fallback;
    return state.max_positions ?? fallback;
  } catch {
    return fallback;
  }
}
