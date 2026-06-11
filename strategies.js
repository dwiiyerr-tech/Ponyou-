/**
 * Strategy Preset Registry (inspired by Charon's strategy gates).
 *
 * Ponyou ships with 6 presets:
 *  - scalping          : default — instant scalping new pair (Freqtrade-style ROI)
 *  - sniper            : early entry pump.fun-style — strict fees + mcap gates
 *  - dip_buy           : wait for dip from ATH on more mature tokens
 *  - smart_money       : higher mcap, larger holder count, partial TP on
 *  - degen             : lowest filters, rule-based (no LLM), tight stops
 *  - day_phase_trading : short swing 3-7 hari, entry weekend DCA, exit weekday
 *
 * Active strategy is persisted in ./active-strategy.json (hot-readable).
 * User overrides per strategy are stored in ./strategies-overrides.json
 * and merged on top of the preset at read-time.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteJson } from "./atomic-write.js";
import { log } from "./logger.js";
import { getRuntimeSelector } from "./strategy-runtime-selector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVE_FILE = process.env.PONYOU_ACTIVE_STRATEGY_FILE
  || path.join(__dirname, "active-strategy.json");
const OVERRIDES_FILE = process.env.PONYOU_STRATEGY_OVERRIDES_FILE
  || path.join(__dirname, "strategies-overrides.json");

// ─── Built-in presets ─────────────────────────────────────────
//
// Filter key notes:
//   minHolderAgeHours — read by strategy-matcher.js + portfolio-manager.js as a
//     *token* age gate (how old the pair must be before entry). The 4-filter
//     run4FilterProtocol uses rug_signals.fresh_funded_holders (a fixed >=3
//     threshold) instead, so tuning minHolderAgeHours does NOT change the
//     fresh-funded holder check — it only affects the token-age gate.
//
//   global_fees_sol — skipped when the field is null (Jupiter didn't return fee
//     data). Only fires when real fee data is present and below min_token_fees_sol.

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
      // Micro-cap bounds — without these, scalping matched any mcap. In a
      // multi-strategy set, a $10M token could fail degen/smart_money yet
      // slip through scalping (gate skipped when bounds undefined). Mirror
      // sniper's micro-cap window so scalping stays scoped to fresh pairs.
      min_mcap_usd: 3000,
      max_mcap_usd: 200000,
      min_token_fees_sol: 1,
    },
    minimal_roi: { "0": 0.60, "5": 0.30, "15": 0.15, "30": 0.05, "60": 0.0 },
    stoploss: -0.15,
    trailing_stop: { enabled: true, positive_offset: 0.20, positive_distance: 0.05 },
    partial_tp: { enabled: false, at_pct: 0, sell_pct: 0 },
    use_llm: true,
    llm_min_confidence: 0,
    staged_entry: { enabled: false },
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
      maxAllowedFlags: 1,       // was 0 — allows 1 flag (e.g. young holders)
      min_mcap_usd: 7000,
      max_mcap_usd: 200000,
      min_token_fees_sol: 1,    // was 10 — 10 SOL fees near-impossible; 1 SOL realistic
    },
    minimal_roi: { "0": 0.50, "3": 0.30, "10": 0.15, "20": 0.05 },
    stoploss: -0.25,
    trailing_stop: { enabled: true, positive_offset: 0.20, positive_distance: 0.08 },
    partial_tp: { enabled: false, at_pct: 0, sell_pct: 0 },
    use_llm: true,
    llm_min_confidence: 50,
    staged_entry: { enabled: false },
    roi_presets: {
      EXTREME: { "0": 0.50, "2": 0.30, "8": 0.15, "20": 0.0 },
      HOT:     { "0": 0.50, "3": 0.30, "10": 0.15, "20": 0.05 },
      NORMAL:  { "0": 0.40, "3": 0.25, "10": 0.12, "25": 0.0 },
      COLD:    { "0": 0.25, "5": 0.15, "15": 0.05, "30": -0.05 },
      DEAD:    { "0": 0.15, "5": 0.08, "15": 0.0, "30": -0.15 },
    },
  },

  dip_buy: {
    id: "dip_buy",
    name: "Dip Buy",
    description: "Mid-cap DCA entry — 3-stage averaging down on price dips. ATH gate only enforced when data is available.",
    filters: {
      maxGasFeeLevel: "high",
      minHolderAgeHours: 1,
      minTopHolderSol: 0.05,
      maxEntryPumpMc: 25000,
      maxAllowedFlags: 2,
      min_mcap_usd: 25000,
      max_mcap_usd: 500000,
      // max_ath_distance_pct only enforced when dip_from_ath_pct is provided upstream.
      // When missing (common for fresh tokens), gate is silently skipped.
      max_ath_distance_pct: -40,
    },
    minimal_roi: { "0": 0.30, "10": 0.20, "30": 0.10, "60": 0.03 },
    stoploss: -0.20,
    trailing_stop: { enabled: true, positive_offset: 0.10, positive_distance: 0.05 },
    partial_tp: { enabled: false, at_pct: 0, sell_pct: 0 },
    use_llm: true,
    llm_min_confidence: 60,
    // Beli 3 stage saat harga turun: averaging down di setiap dip
    staged_entry: {
      enabled: true,
      stages: 3,
      stage_pct: [35, 35, 30],     // 35% first, 35% at -5%, 30% at -10%
      trigger_type: "price",
      price_trigger_pct: -5,        // buy next stage every -5% from last entry avg
    },
    roi_presets: {
      EXTREME: { "0": 0.30, "5": 0.20, "20": 0.10, "45": 0.0 },
      HOT:     { "0": 0.30, "10": 0.20, "30": 0.10, "60": 0.03 },
      NORMAL:  { "0": 0.25, "15": 0.15, "45": 0.08, "90": 0.0 },
      COLD:    { "0": 0.20, "30": 0.10, "60": 0.05, "120": -0.05 },
      DEAD:    { "0": 0.12, "30": 0.05, "60": 0.0, "120": -0.15 },
    },
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
      maxAllowedFlags: 1,       // was 0 — allows 1 flag so realistic tokens can match
      min_mcap_usd: 10000,
      max_mcap_usd: 1000000,
      min_holders: 300,         // was 1000 — 1000 holders almost never seen at entry price
      max_top10_pct: 50,
    },
    minimal_roi: { "0": 1.0, "15": 0.50, "45": 0.20 },
    stoploss: -0.25,
    trailing_stop: { enabled: true, positive_offset: 0.30, positive_distance: 0.12 },  // was disabled — no trailing = +90% can round-trip to -25% SL
    partial_tp: { enabled: true, at_pct: 100, sell_pct: 50 },
    use_llm: true,
    llm_min_confidence: 70,
    staged_entry: {
      enabled: true,
      stages: 2,
      stage_pct: [60, 40],
      trigger_type: "price",
      price_trigger_pct: -8,
    },
    roi_presets: {
      EXTREME: { "0": 1.0, "10": 0.50, "30": 0.20, "60": 0.05 },
      HOT:     { "0": 1.0, "15": 0.50, "45": 0.20 },
      NORMAL:  { "0": 0.80, "20": 0.40, "60": 0.15, "120": 0.0 },
      COLD:    { "0": 0.50, "30": 0.25, "90": 0.10, "180": -0.05 },
      DEAD:    { "0": 0.30, "30": 0.15, "90": 0.0, "180": -0.15 },
    },
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
    staged_entry: { enabled: false },
    roi_presets: {
      EXTREME: { "0": 0.30, "3": 0.20, "10": 0.10, "20": 0.0 },
      HOT:     { "0": 0.30, "5": 0.15, "15": 0.05 },
      NORMAL:  { "0": 0.25, "5": 0.12, "15": 0.03, "30": -0.05 },
      COLD:    { "0": 0.15, "10": 0.05, "20": 0.0, "30": -0.10 },
      DEAD:    { "0": 0.10, "10": 0.0, "20": -0.05, "30": -0.15 },
    },
  },

  day_phase_trading: {
    id: "day_phase_trading",
    name: "Day Phase Trade",
    description: "Short swing 3-7 hari — entry weekend DCA, exit weekday saat revival pump. Main di fase Cooldown/Sideway.",
    // ── Filter Entry ──────────────────────────────────────────
    // Token HARUS: FDV > $1M, dip 50-70% dari ATH, sideway 3-5 hari,
    // holder count stabil/naik tipis, naratif masih relevan.
    filters: {
      // Entry gate
      maxGasFeeLevel: "extreme",       // Hanya blokir saat gas ekstrem
      minHolderAgeHours: 24,           // Holder harus mature (swing butuh stabilitas)
      minTopHolderSol: 0.5,            // Top holder wajib punya ≥0.5 SOL (serius)
      maxEntryPumpMc: 50000,           // Pump-ratio gate (NOT a max-mcap cap — only fires when initial_mcap < 50000)
      maxAllowedFlags: 2,              // Longgar — swing tidak perlu timing sempurna
      // MCap / FDV gate — lowered from $1M: social signals reach $500K+ so this band is reachable
      min_mcap_usd: 500000,            // was 1000000 — $1M band has no feed; $500K matches social signal mid-caps
      max_mcap_usd: 50000000,          // Max $50M FDV
      // Holder gate
      min_holders: 500,                // Min 500 holders — distribusi sehat
      max_top10_pct: 40,               // Top 10 holders max 40% supply
      // Dip gate (dari ATH)
      max_ath_distance_pct: -50,       // HARUS sudah di bawah -50% dari ATH (diskusi fase 3)
    },
    // ── Exit & Money Management ────────────────────────────────
    // ROI bertahap untuk swing 3-7 hari (dalam menit):
    //   Hari ke-3 (4320m): 40%  → jual 30% posisi
    //   Hari ke-5 (7200m): 55%  → jual 30% posisi
    //   Hari ke-7 (10080m): 70% → jual 40% sisa
    //   Setelah 7 hari tanpa profit: auto-cut
    minimal_roi: {
      "0":      0.70,    // 70% langsung — hampir tidak pernah trigger, safety only
      "4320":   0.40,    // Hari ke-3: 40% profit → exit pertama
      "7200":   0.55,    // Hari ke-5: 55% profit → exit kedua
      "10080":  0.70,    // Hari ke-7: 70% profit → exit penuh
      "10081": -0.99,    // Setelah hari ke-7 → force exit (PnL selalu >= -99%)
    },
    stoploss: -0.30,                     // Stop loss 30% — lebar karena swing
    trailing_stop: {
      enabled: true,
      positive_offset: 0.30,             // Trailing aktif setelah +30% profit
      positive_distance: 0.10,           // Jarak trailing 10% dari peak
    },
    // ── Partial TP untuk exit bertahap ─────────────────────────
    partial_tp: {
      enabled: true,
      at_pct: 40,                        // Trigger partial TP pertama di +40%
      sell_pct: 30,                      // Jual 30% posisi
    },
    use_llm: true,
    llm_min_confidence: 50,
    // DCA 2 hari: 50% Sabtu, 50% Minggu (1440 menit = 24 jam)
    staged_entry: {
      enabled: true,
      stages: 2,
      stage_pct: [50, 50],
      trigger_type: "time",
      time_trigger_min: 1440,            // 24 jam antar stage
    },
    // Swing presets — agresif di HOT/NORMAL, lebih sabar di COLD/DEAD.
    roi_presets: {
      EXTREME: { "0": 0.80, "1440": 0.50, "4320": 0.30, "7200": 0.0, "10080": -0.99 },
      HOT:     { "0": 0.70, "4320": 0.40, "7200": 0.55, "10080": 0.70, "10081": -0.99 },
      NORMAL:  { "0": 0.70, "4320": 0.35, "7200": 0.50, "10080": 0.65, "10081": -0.99 },
      COLD:    { "0": 0.50, "4320": 0.25, "7200": 0.35, "10080": 0.50, "10081": -0.99 },
      DEAD:    { "0": 0.30, "4320": 0.15, "7200": 0.20, "10080": 0.30, "10081": -0.99 },
    },
  },
};

export const STRATEGY_IDS = Object.keys(PRESETS);
const DEFAULT_STRATEGY = "scalping";

// ─── Active strategy persistence ──────────────────────────────
//
// Read-through cache: getStrategy() runs on every entry filter, every ROI
// check, every trailing-stop check, etc. Without a cache that is 5-10 sync
// disk reads per position per management cycle. We invalidate on write.

const _readCache = new Map(); // file -> { mtimeMs, data }

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    const cached = _readCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    _readCache.set(file, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch { return null; }
}

function writeJson(file, data) {
  atomicWriteJson(file, data);
  _readCache.delete(file);
}

let _fallbackWarned = false;
// Last successfully-read active config. A momentary unreadable file (concurrent
// atomic write) must NOT collapse the operator's real strategy set to the hard
// default — that silently swaps a rule-based primary (degen) for an LLM one
// (scalping) and blocks cold-start deploys behind the workflow.llm_can_buy gate.
let _lastGoodId = null;
let _lastGoodIds = null;

export function getActiveStrategyId() {
  const data = readJsonSafe(ACTIVE_FILE);
  const id = data?.id;
  if (id && PRESETS[id]) { _lastGoodId = id; return id; }
  // Transient read failure: reuse the last id successfully read this process.
  if (_lastGoodId && PRESETS[_lastGoodId]) return _lastGoodId;
  // Warn once per process when the active-strategy file is permanently missing.
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    const cause = !data ? "file missing/unreadable" : `unknown id "${id}"`;
    log("strategy", `WARN: active-strategy fallback to "${DEFAULT_STRATEGY}" (${cause})`);
  }
  return DEFAULT_STRATEGY;
}

export function getActiveStrategy() {
  return getStrategy();
}

export function setActiveStrategy(id) {
  if (!PRESETS[id]) throw new Error(`Unknown strategy: ${id}. Valid: ${STRATEGY_IDS.join(", ")}`);
  const data = readJsonSafe(ACTIVE_FILE) || {};
  // Preserve multi-strategy ids if set, update primary id
  const ids = Array.isArray(data.ids) && data.ids.length > 0
    ? data.ids.includes(id) ? data.ids : [id]
    : [id];
  writeJson(ACTIVE_FILE, { id, ids, updated_at: new Date().toISOString() });
  log("strategy", `Active strategy switched to "${id}"`);
  return id;
}

// ─── Multi-strategy support ────────────────────────────────────
// Returns array of all active strategy IDs. Single-strategy mode returns [id].

export function getActiveStrategyIds() {
  const data = readJsonSafe(ACTIVE_FILE);
  if (Array.isArray(data?.ids) && data.ids.length > 0) {
    const valid = data.ids.filter(id => PRESETS[id]);
    if (valid.length > 0) { _lastGoodIds = valid; return valid; }
  }
  // Transient read failure: don't collapse a multi-strategy set to a single
  // default — reuse the last set read this process (cache is warm from boot).
  if (Array.isArray(_lastGoodIds) && _lastGoodIds.length > 0) return _lastGoodIds;
  return [getActiveStrategyId()];
}

export function setActiveStrategies(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids must be a non-empty array");
  const valid = ids.filter(id => PRESETS[id]);
  const invalid = ids.filter(id => !PRESETS[id]);
  if (valid.length === 0) throw new Error(`No valid strategy IDs. Valid: ${STRATEGY_IDS.join(", ")}`);
  if (invalid.length > 0) throw new Error(`Unknown: ${invalid.join(", ")}. Valid: ${STRATEGY_IDS.join(", ")}`);
  writeJson(ACTIVE_FILE, { id: valid[0], ids: valid, updated_at: new Date().toISOString() });
  log("strategy", `Active strategies: [${valid.join(", ")}]`);
  return valid;
}

/**
 * Switch the primary strategy without destroying a multi-strategy set.
 * setActiveStrategy(id) collapses ids to [id] whenever the new id is not
 * already in the set — one switch_strategy tool call from the LLM wiped the
 * band-covering set back to a single micro-cap strategy (observed live
 * 2026-06-11: ["scalping","degen"] → ["scalping"]). With preserve=true the
 * new id becomes primary and the rest of the set stays active.
 */
export function switchPrimaryPreservingSet(id, { preserve = false } = {}) {
  if (!PRESETS[id]) throw new Error(`Unknown strategy: ${id}. Valid: ${STRATEGY_IDS.join(", ")}`);
  const current = getActiveStrategyIds();
  if (preserve && current.length > 1) {
    return setActiveStrategies([id, ...current.filter((x) => x !== id)]);
  }
  setActiveStrategy(id);
  return [id];
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
  // Reject typos before persisting. Without this, an unrecognized key was
  // stringified and stored, never taking effect — operator gets no signal.
  if (!isKnownOverrideKey(key)) {
    const all = [...ROOT_OVERRIDE_KEYS, ...FILTER_OVERRIDE_KEYS].sort();
    throw new Error(`Unknown override key "${key}". Known keys: ${all.join(", ")}`);
  }
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

// Keys that map cleanly to a nested preset path. Used both by applyOverrides
// (dispatch) and by setStrategyOverride (input validation). When adding a
// new override key, list it here AND add a case in applyOverrides.
const ROOT_OVERRIDE_KEYS = new Set([
  "stoploss",
  "trailing_enabled", "trailing_offset", "trailing_distance",
  "partial_tp_enabled", "partial_tp_at", "partial_tp_sell",
  "use_llm", "llm_min_confidence",
]);

// Keys that may legitimately land inside `preset.filters`. Snapshot from the
// six built-in presets; new filter keys should be added here too. Anything
// outside ROOT_OVERRIDE_KEYS ∪ FILTER_OVERRIDE_KEYS is treated as a typo
// and rejected by setStrategyOverride / warned-about by applyOverrides.
const FILTER_OVERRIDE_KEYS = new Set([
  "maxGasFeeLevel", "minHolderAgeHours", "minTopHolderSol",
  "maxEntryPumpMc", "maxAllowedFlags",
  "min_mcap_usd", "max_mcap_usd",
  "min_token_fees_sol", "min_fee_claim_sol",
  "min_holders", "max_top10_pct",
  "max_ath_distance_pct",
]);

export function isKnownOverrideKey(key) {
  return ROOT_OVERRIDE_KEYS.has(key) || FILTER_OVERRIDE_KEYS.has(key);
}

/**
 * Apply flat-key overrides to a nested preset shape.
 * Maps friendly keys (e.g. "trailing_offset") into preset paths
 * (trailing_stop.positive_offset, partial_tp.at_pct, etc).
 *
 * Always returns a fresh deep-clone so callers can safely attach metadata
 * (e.g. _runtime_source, _evolved_id) without mutating the global PRESETS
 * registry. Previously this short-circuited and returned the preset itself
 * when no overrides existed — that leaked mutation into PRESETS and caused
 * cross-call regime metadata pollution.
 */
function applyOverrides(preset, override) {
  const out = JSON.parse(JSON.stringify(preset));
  if (!override) return out;
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
        if (FILTER_OVERRIDE_KEYS.has(key)) {
          out.filters[key] = value;
        } else {
          // Unknown key — log warn so typos surface instead of being silently
          // dropped on a non-existent root field. Common cause: snake_case
          // vs camelCase confusion, or trailing-letter typos.
          log("strategy", `WARN: unknown override key "${key}" ignored (preset=${preset.id}, value=${JSON.stringify(value)})`);
        }
    }
  }
  return out;
}

/**
 * Return the effective active strategy (preset + overrides), always fresh from disk.
 *
 * Resolution order (lowest → highest priority):
 *   1. PRESET (built-in default)
 *   2. user override (./strategies-overrides.json)
 *   3. evolved override (Strategy Evolution registry, opt-in via runtimeSelector)
 *
 * `context.regime` lets the caller pass current market regime so the
 * runtime selector can find an evolved strategy specifically optimized
 * for that regime. When omitted (or when runtime selector is disabled /
 * no evolved match), evolved overrides are skipped.
 *
 * The returned object carries _runtime_source / _evolved_id metadata so
 * downstream code (logs, dashboard, audit) can see whether evolved rules
 * were actually applied.
 */
export function getStrategy(id = null, context = {}) {
  const targetId = id || getActiveStrategyId();
  const preset = PRESETS[targetId] || PRESETS[DEFAULT_STRATEGY];
  const userOverrides = loadOverrides()[targetId];
  let merged = applyOverrides(preset, userOverrides);
  merged._runtime_source = "preset";
  merged._evolved_id = null;

  // ── Strategy Evolution runtime override (opt-in) ────────────────
  const selector = getRuntimeSelector();
  if (selector && typeof context?.regime === "string" && context.regime.length > 0) {
    let resolved;
    try {
      resolved = selector.effectiveOverrides(context.regime);
    } catch {
      resolved = null;
    }
    if (resolved && (resolved.overrides || resolved.roiPatch)) {
      // Live mode: apply on top of user overrides. Shadow mode: selector
      // already set overrides=null, so this stays a no-op (but the
      // selector logged the diff).
      if (resolved.overrides) {
        merged = applyOverrides(merged, resolved.overrides);
      }
      if (resolved.roiPatch && typeof resolved.roiPatch === "object") {
        if (merged.minimal_roi && typeof merged.minimal_roi === "object") {
          merged.minimal_roi = { ...merged.minimal_roi, ...resolved.roiPatch };
        }
        // checkROI prefers roi_presets[regime] over minimal_roi. Patch the
        // regime-specific table too so the evolved TP actually fires when
        // the matching regime ROI lookup happens.
        if (context.regime && merged.roi_presets && typeof merged.roi_presets === "object") {
          const regimeRoi = merged.roi_presets[context.regime];
          if (regimeRoi && typeof regimeRoi === "object") {
            merged.roi_presets = {
              ...merged.roi_presets,
              [context.regime]: { ...regimeRoi, ...resolved.roiPatch },
            };
          }
        }
      }
      merged._runtime_source = resolved.source;
      merged._evolved_id = resolved.evolvedId;
      merged._evolved_name = resolved.evolvedName;
    } else if (resolved) {
      // Shadow result with no actual overrides — record for diagnostics.
      merged._runtime_source = resolved.source;
      merged._evolved_id = resolved.evolvedId;
      merged._evolved_name = resolved.evolvedName;
    }
  }

  return merged;
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
