/**
 * Strategy Preset Registry (inspired by Charon's strategy gates).
 *
 * Ponyou ships with 5 presets:
 *  - scalping      : default — instant scalping new pair (Freqtrade-style ROI)
 *  - sniper        : early entry pump.fun-style — strict fees + mcap gates
 *  - dip_buy       : wait for dip from ATH on more mature tokens
 *  - smart_money   : higher mcap, larger holder count, partial TP on
 *  - degen         : lowest filters, rule-based (no LLM), tight stops
 *
 * Active strategy is persisted in ./active-strategy.json (hot-readable).
 * User overrides per strategy are stored in ./strategies-overrides.json
 * and merged on top of the preset at read-time.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_FILE = path.join(__dirname, "active-strategy.json");
const OVERRIDES_FILE = path.join(__dirname, "strategies-overrides.json");

// ─── Built-in presets ─────────────────────────────────────────

export const PRESETS = {
  scalping: {
    id: "scalping",
    name: "Instant Scalping New Pair",
    description: "Default Ponyou: Freqtrade-style ROI on fresh pairs.",
    filters: {
      maxGasFeeLevel: "high",
      minHolderAgeHours: 24,
      minTopHolderSol: 0.2,
      maxEntryPumpMc: 3000,
      maxAllowedFlags: 1,
    },
    minimal_roi: { "0": 0.60, "5": 0.30, "15": 0.15, "30": 0.05, "60": 0.0 },
    stoploss: -0.15,
    trailing_stop: { enabled: true, positive_offset: 0.20, positive_distance: 0.05 },
    partial_tp: { enabled: false, at_pct: 0, sell_pct: 0 },
    use_llm: true,
    llm_min_confidence: 0,
    roi_presets: {
      EXTREME: { "0": 0.60, "2": 0.35, "10": 0.25, "20": 0.15, "45": 0.05, "60": 0.0 },
      HOT:     { "0": 0.50, "5": 0.30, "15": 0.20, "30": 0.10, "60": 0.02 },
      NORMAL:  { "0": 0.40, "5": 0.25, "15": 0.15, "30": 0.05, "60": 0.0 },
      COLD:    { "0": 0.25, "5": 0.15, "15": 0.10, "30": 0.05, "60": -0.05 },
      DEAD:    { "0": 0.15, "5": 0.10, "15": 0.05, "30": 0.0,  "45": -0.10 },
    },
  },

  sniper: {
    id: "sniper",
    name: "Sniper",
    description: "Strict fees + low-mcap window. Fast entry, hard stops.",
    filters: {
      maxGasFeeLevel: "high",
      minHolderAgeHours: 24,
      minTopHolderSol: 0.2,
      maxEntryPumpMc: 3000,
      maxAllowedFlags: 0,
      min_mcap_usd: 7000,
      max_mcap_usd: 200000,
      min_token_fees_sol: 10,
      min_fee_claim_sol: 0.5,
    },
    minimal_roi: { "0": 0.50, "3": 0.30, "10": 0.15, "20": 0.05 },
    stoploss: -0.25,
    trailing_stop: { enabled: true, positive_offset: 0.20, positive_distance: 0.08 },
    partial_tp: { enabled: false, at_pct: 0, sell_pct: 0 },
    use_llm: true,
    llm_min_confidence: 50,
  },

  dip_buy: {
    id: "dip_buy",
    name: "Dip Buy",
    description: "Wait for ATH-distance dip on more mature tokens.",
    filters: {
      maxGasFeeLevel: "high",
      minHolderAgeHours: 1,
      minTopHolderSol: 0.05,
      maxEntryPumpMc: 25000,
      maxAllowedFlags: 2,
      min_mcap_usd: 25000,
      max_mcap_usd: 500000,
      max_ath_distance_pct: -40,
    },
    minimal_roi: { "0": 0.30, "10": 0.20, "30": 0.10, "60": 0.03 },
    stoploss: -0.20,
    trailing_stop: { enabled: true, positive_offset: 0.10, positive_distance: 0.05 },
    partial_tp: { enabled: false, at_pct: 0, sell_pct: 0 },
    use_llm: true,
    llm_min_confidence: 60,
  },

  smart_money: {
    id: "smart_money",
    name: "Smart Money",
    description: "Stricter filters, higher mcap, partial TP at 100%.",
    filters: {
      maxGasFeeLevel: "high",
      minHolderAgeHours: 24,
      minTopHolderSol: 0.2,
      maxEntryPumpMc: 5000,
      maxAllowedFlags: 0,
      min_mcap_usd: 10000,
      max_mcap_usd: 1000000,
      min_holders: 1000,
      max_top10_pct: 50,
    },
    minimal_roi: { "0": 1.0, "15": 0.50, "45": 0.20 },
    stoploss: -0.25,
    trailing_stop: { enabled: false, positive_offset: 0, positive_distance: 0 },
    partial_tp: { enabled: true, at_pct: 100, sell_pct: 50 },
    use_llm: true,
    llm_min_confidence: 70,
  },

  degen: {
    id: "degen",
    name: "Degen",
    description: "Loose filters, tight stops, no LLM — pure rule-based.",
    filters: {
      maxGasFeeLevel: "high",
      minHolderAgeHours: 1,
      minTopHolderSol: 0.05,
      maxEntryPumpMc: 5000,
      maxAllowedFlags: 2,
      min_mcap_usd: 5000,
      max_mcap_usd: 100000,
    },
    minimal_roi: { "0": 0.30, "5": 0.15, "15": 0.05 },
    stoploss: -0.15,
    trailing_stop: { enabled: true, positive_offset: 0.10, positive_distance: 0.04 },
    partial_tp: { enabled: false, at_pct: 0, sell_pct: 0 },
    use_llm: false,
    llm_min_confidence: 0,
  },
};

export const STRATEGY_IDS = Object.keys(PRESETS);
const DEFAULT_STRATEGY = "scalping";

// ─── Active strategy persistence ──────────────────────────────

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function getActiveStrategyId() {
  const data = readJsonSafe(ACTIVE_FILE);
  const id = data?.id;
  if (id && PRESETS[id]) return id;
  return DEFAULT_STRATEGY;
}

export function setActiveStrategy(id) {
  if (!PRESETS[id]) throw new Error(`Unknown strategy: ${id}. Valid: ${STRATEGY_IDS.join(", ")}`);
  writeJson(ACTIVE_FILE, { id, updated_at: new Date().toISOString() });
  log("strategy", `Active strategy switched to "${id}"`);
  return id;
}

// ─── Overrides (per-strategy user tweaks) ─────────────────────

function loadOverrides() {
  return readJsonSafe(OVERRIDES_FILE) || {};
}

function saveOverrides(overrides) {
  writeJson(OVERRIDES_FILE, overrides);
}

const NUMERIC_KEYS = new Set([
  "stoploss", "llm_min_confidence",
  "trailing_offset", "trailing_distance",
  "partial_tp_at", "partial_tp_sell",
  "min_mcap_usd", "max_mcap_usd", "min_holders", "max_top10_pct",
  "min_token_fees_sol", "min_fee_claim_sol", "max_ath_distance_pct",
  "maxEntryPumpMc", "minHolderAgeHours", "minTopHolderSol", "maxAllowedFlags",
]);
const BOOL_KEYS = new Set(["trailing_enabled", "partial_tp_enabled", "use_llm"]);

/**
 * Set a single override for a strategy. Hot-applies on next getStrategy() call.
 * Returns the parsed value (or null on invalid).
 */
export function setStrategyOverride(id, key, rawValue) {
  if (!PRESETS[id]) throw new Error(`Unknown strategy: ${id}`);
  let value;
  if (NUMERIC_KEYS.has(key)) {
    value = Number(rawValue);
    if (!Number.isFinite(value)) return null;
  } else if (BOOL_KEYS.has(key)) {
    value = rawValue === true || rawValue === "true" || rawValue === "1" || rawValue === "yes";
  } else {
    value = String(rawValue);
  }
  const overrides = loadOverrides();
  if (!overrides[id]) overrides[id] = {};
  overrides[id][key] = value;
  saveOverrides(overrides);
  log("strategy", `Override ${id}.${key} = ${value}`);
  return value;
}

export function clearStrategyOverrides(id) {
  const overrides = loadOverrides();
  if (id) delete overrides[id];
  else for (const k of Object.keys(overrides)) delete overrides[k];
  saveOverrides(overrides);
}

/**
 * Apply flat-key overrides to a nested preset shape.
 * Maps friendly keys (e.g. "trailing_offset") into preset paths
 * (trailing_stop.positive_offset, partial_tp.at_pct, etc).
 */
function applyOverrides(preset, override) {
  if (!override) return preset;
  const out = JSON.parse(JSON.stringify(preset));
  for (const [key, value] of Object.entries(override)) {
    switch (key) {
      case "stoploss":             out.stoploss = value; break;
      case "trailing_enabled":     out.trailing_stop.enabled = value; break;
      case "trailing_offset":      out.trailing_stop.positive_offset = value; break;
      case "trailing_distance":    out.trailing_stop.positive_distance = value; break;
      case "partial_tp_enabled":   out.partial_tp.enabled = value; break;
      case "partial_tp_at":        out.partial_tp.at_pct = value; break;
      case "partial_tp_sell":      out.partial_tp.sell_pct = value; break;
      case "use_llm":              out.use_llm = value; break;
      case "llm_min_confidence":   out.llm_min_confidence = value; break;
      default:
        if (key in out.filters) out.filters[key] = value;
        else out[key] = value;
    }
  }
  return out;
}

/**
 * Return the effective active strategy (preset + overrides), always fresh from disk.
 */
export function getStrategy(id = null) {
  const targetId = id || getActiveStrategyId();
  const preset = PRESETS[targetId] || PRESETS[DEFAULT_STRATEGY];
  const overrides = loadOverrides()[targetId];
  return applyOverrides(preset, overrides);
}

export function listStrategies() {
  const activeId = getActiveStrategyId();
  return STRATEGY_IDS.map(id => {
    const s = getStrategy(id);
    return {
      id,
      name: s.name,
      description: s.description,
      active: id === activeId,
      stoploss_pct: s.stoploss * 100,
      trailing: s.trailing_stop?.enabled || false,
      partial_tp: s.partial_tp?.enabled
        ? `${s.partial_tp.sell_pct}% @ +${s.partial_tp.at_pct}%`
        : "off",
      use_llm: s.use_llm,
    };
  });
}
