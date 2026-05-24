/**
 * strategy-runtime-selector.js
 *
 * Bridges the Strategy Evolution registry → runtime trade decisions.
 *
 * Without this module, evolved strategies are *write-only* — the producer
 * + gate + proposal + registry create strategies but the agent never reads
 * them, so every trade still uses the hardcoded PRESETS in strategies.js.
 *
 * This selector inverts that: at trade time, the agent consults the
 * registry for an active evolved strategy that matches the current
 * regime, validates it meets a live-trade floor, and surfaces a set of
 * overrides shaped for strategies.js#applyOverrides(). Result: getStrategy()
 * returns PRESET + user-config + evolved overrides, in that priority order.
 *
 * Three modes (all opt-in via config.strategy.runtimeSelector):
 *   - enabled=false       (default): selector never returns overrides
 *   - mode="shadow"       picks evolved, LOGS diff vs preset, returns null
 *                         (agent behavior unchanged — pure observation)
 *   - mode="live"         picks evolved, returns overrides (agent applies)
 *
 * Singleton model:
 *   - `setRuntimeRegistry(registry, config, logger)` is called once at
 *     startup (index.js) after the registry instance is built.
 *   - `getRuntimeSelector()` returns the singleton. strategies.js uses it.
 *   - When unset (no Strategy Evolution at all), selector is a no-op that
 *     always returns null. Safe for tests + agents without evolution.
 */

const DEFAULT_CACHE_TTL_MS = 60_000;
const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

let _singleton = null;

function clampNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

/**
 * Map evolved rules (composer / producer output) → preset-override shape.
 * Evolved rules are deliberately *additive*: only fields explicitly set in
 * rules override the preset; everything else falls back.
 *
 * Recognized evolved fields:
 *   tpPct / takeProfitPct / takeProfitBps    → first ROI bucket
 *   stopPct / stopLossPct / stopLossBps      → stoploss
 *   trailingOffset                           → trailing_offset
 *   trailingDistance                         → trailing_distance
 *   partialTpAt                              → partial_tp_at + enables
 *   partialTpSell                            → partial_tp_sell + enables
 *   entryRsi                                 → ignored at runtime (entry-side)
 */
export function evolvedRulesToOverrides(rules = {}) {
  if (!rules || typeof rules !== "object") return null;

  const overrides = {};
  let touched = false;

  // ── Stop-loss ────────────────────────────────────────────────────
  const stopRaw = rules.stopLossPct ?? rules.stopPct ?? (
    Number.isFinite(rules.stopLossBps) ? rules.stopLossBps / 100 : undefined
  );
  if (stopRaw != null && Number.isFinite(Number(stopRaw))) {
    // Preset stoploss is a NEGATIVE decimal (-0.15 = -15%). Evolved rules
    // typically express it as a positive magnitude in percent.
    const magnitude = Math.abs(Number(stopRaw));
    overrides.stoploss = -magnitude / 100;
    touched = true;
  }

  // ── Trailing ─────────────────────────────────────────────────────
  if (Number.isFinite(rules.trailingOffset)) {
    overrides.trailing_offset = Number(rules.trailingOffset);
    overrides.trailing_enabled = true;
    touched = true;
  }
  if (Number.isFinite(rules.trailingDistance)) {
    overrides.trailing_distance = Number(rules.trailingDistance);
    overrides.trailing_enabled = true;
    touched = true;
  }

  // ── Partial TP ──────────────────────────────────────────────────
  if (Number.isFinite(rules.partialTpAt)) {
    overrides.partial_tp_at = Number(rules.partialTpAt);
    overrides.partial_tp_enabled = true;
    touched = true;
  }
  if (Number.isFinite(rules.partialTpSell)) {
    overrides.partial_tp_sell = Number(rules.partialTpSell);
    overrides.partial_tp_enabled = true;
    touched = true;
  }

  return touched ? overrides : null;
}

/**
 * Compute the ROI patch separately — evolved tpPct rewrites the *first*
 * minimal_roi bucket but doesn't touch later horizons. Returned as a
 * separate slot because preset.minimal_roi is a nested object, not a flat
 * key, and strategies.js#applyOverrides doesn't know how to splice it.
 */
export function evolvedRulesToRoiPatch(rules = {}) {
  if (!rules || typeof rules !== "object") return null;
  const tpRaw = rules.tpPct ?? rules.takeProfitPct ?? (
    Number.isFinite(rules.takeProfitBps) ? rules.takeProfitBps / 100 : undefined
  );
  if (tpRaw == null || !Number.isFinite(Number(tpRaw))) return null;
  return { "0": Number(tpRaw) / 100 };
}

function meetsFloor(strategy, cfg) {
  if (!strategy) return false;
  if (strategy.status !== "active") return false;
  const liveScore = normalizeRate(strategy.scores?.live);
  if (liveScore == null) return false;
  if (liveScore < cfg.minLiveScoreForOverride) return false;
  const liveTrades = Number(strategy.evidence?.live?.trades ?? strategy.scores?.liveTrades ?? 0);
  if (liveTrades < cfg.minLiveTradesForOverride) return false;
  return true;
}

function diffOverrides(presetOverrides = {}, evolvedOverrides = {}) {
  const out = {};
  const keys = new Set([...Object.keys(presetOverrides || {}), ...Object.keys(evolvedOverrides || {})]);
  for (const key of keys) {
    if (presetOverrides[key] !== evolvedOverrides[key]) {
      out[key] = { from: presetOverrides[key], to: evolvedOverrides[key] };
    }
  }
  return out;
}

export class StrategyRuntimeSelector {
  #registry;
  #config;
  #logger;
  #cache = new Map();   // regime → { ts, result }

  constructor({ registry = null, config = {}, logger = NOOP_LOGGER } = {}) {
    this.#registry = registry;
    this.#config = this.#normalizeConfig(config);
    this.#logger = logger || NOOP_LOGGER;
  }

  #normalizeConfig(cfg = {}) {
    return {
      enabled:                  Boolean(cfg.enabled ?? false),
      mode:                     cfg.mode === "live" ? "live" : "shadow",
      minLiveScoreForOverride:  clampNumber(cfg.minLiveScoreForOverride, 0.85),
      minLiveTradesForOverride: Math.max(0, Math.floor(clampNumber(cfg.minLiveTradesForOverride, 20))),
      cacheTtlMs:               Math.max(0, clampNumber(cfg.cacheTtlMs, DEFAULT_CACHE_TTL_MS)),
    };
  }

  get config() { return { ...this.#config }; }

  /**
   * Resolve evolved overrides for a regime (or null).
   * Result shape:
   *   {
   *     source:      "evolved" | "preset" | "shadow",
   *     evolvedId:   string | null,
   *     evolvedName: string | null,
   *     overrides:   object | null,   // flat keys for applyOverrides
   *     roiPatch:    object | null,   // splice into minimal_roi
   *     scores:      object | null,
   *     diagnostics: object,          // why this verdict
   *   }
   * Returns null when no evolved strategy applies — caller falls back to
   * preset + user-config behavior.
   */
  effectiveOverrides(regime = null) {
    if (!this.#config.enabled) return null;
    if (!this.#registry || typeof this.#registry.getBestActive !== "function") return null;

    const cacheKey = regime || "__global__";
    const cached = this.#cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.#config.cacheTtlMs) {
      return cached.result;
    }

    let strategy;
    try {
      strategy = this.#registry.getBestActive(regime || null);
    } catch (err) {
      this.#logger.warn?.(`registry.getBestActive failed: ${err?.message || err}`);
      return null;
    }
    if (!strategy) return this.#cacheAndReturn(cacheKey, null);
    if (!meetsFloor(strategy, this.#config)) {
      this.#logger.info?.(`runtime selector: ${strategy.id} below floor (live=${strategy.scores?.live}, trades=${strategy.evidence?.live?.trades ?? "?"})`);
      return this.#cacheAndReturn(cacheKey, null);
    }

    const overrides = evolvedRulesToOverrides(strategy.rules);
    const roiPatch = evolvedRulesToRoiPatch(strategy.rules);
    if (!overrides && !roiPatch) return this.#cacheAndReturn(cacheKey, null);

    const result = {
      source: this.#config.mode === "live" ? "evolved" : "shadow",
      evolvedId: strategy.id,
      evolvedName: strategy.name,
      overrides: this.#config.mode === "live" ? overrides : null,
      roiPatch: this.#config.mode === "live" ? roiPatch : null,
      scores: strategy.scores ?? null,
      diagnostics: {
        regime,
        floor_passed: true,
        evolved_id: strategy.id,
        evolved_name: strategy.name,
        live_score: strategy.scores?.live,
        live_trades: strategy.evidence?.live?.trades ?? null,
        mode: this.#config.mode,
        overrides_applied: this.#config.mode === "live" ? overrides : null,
        roi_patch_applied: this.#config.mode === "live" ? roiPatch : null,
      },
    };

    if (this.#config.mode === "shadow") {
      this.#logger.info?.(
        `strategy_shadow regime=${regime || "any"} evolved=${strategy.id} ` +
        `would_apply=${JSON.stringify({ overrides, roiPatch })}`
      );
    } else {
      this.#logger.info?.(
        `strategy_live regime=${regime || "any"} evolved=${strategy.id} applied`
      );
    }

    return this.#cacheAndReturn(cacheKey, result);
  }

  #cacheAndReturn(key, result) {
    this.#cache.set(key, { ts: Date.now(), result });
    return result;
  }

  invalidateCache(regime = null) {
    if (regime == null) this.#cache.clear();
    else this.#cache.delete(regime);
  }

  // For diagnostics / dashboard.
  snapshot() {
    return {
      enabled: this.#config.enabled,
      mode: this.#config.mode,
      cachedRegimes: [...this.#cache.entries()].map(([regime, entry]) => ({
        regime,
        ts: entry.ts,
        evolvedId: entry.result?.evolvedId ?? null,
        source: entry.result?.source ?? null,
      })),
    };
  }
}

/**
 * Singleton accessor. Setting overrides the previous instance — index.js
 * calls this once at startup. strategies.js consults the singleton on each
 * getStrategy() call.
 */
export function setRuntimeSelector(selector) {
  _singleton = selector || null;
}

export function getRuntimeSelector() {
  return _singleton;
}

// Re-exported for tests so they can assert the diff helper.
export { diffOverrides };
