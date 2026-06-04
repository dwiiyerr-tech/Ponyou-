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
  // n >= 1 → treat as percentage (100 → 1.0, 1 → 0.01)
  // n < 1  → already a decimal fraction (0.5 = 50%)
  // The old n > 1 threshold made n === 1 ambiguous: it could mean
  // 100 % (expressed as 1.0) or 1 % (expressed as 0.01).
  return n >= 1 ? n / 100 : n;
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
  // Evolved rules may express stoploss as either:
  //   - Positive magnitude in percent (15 = 15% stop)
  //   - Negative decimal (-0.15 = -15% stop, same shape as presets)
  // Normalize both into the preset shape: negative decimal.
  const stopRaw = rules.stopLossPct ?? rules.stopPct ?? (
    Number.isFinite(rules.stopLossBps) ? rules.stopLossBps / 100 : undefined
  );
  if (stopRaw != null && Number.isFinite(Number(stopRaw))) {
    const raw = Number(stopRaw);
    // Already a negative decimal? Use as-is after clamping.
    // Positive magnitude? Convert to negative decimal.
    if (raw < 0 && raw >= -1) {
      // Value is already in preset shape (-0.15 = -15%)
      overrides.stoploss = raw;
    } else {
      // Positive magnitude (15 = 15%) — convert to decimal
      const magnitude = Math.abs(raw);
      overrides.stoploss = -(magnitude / 100);
    }
    // Clamp to reasonable range: stoploss between -50% and -1%
    overrides.stoploss = Math.max(-0.50, Math.min(-0.01, Number(overrides.stoploss)));
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
  // Accept both "active" and "provisional" statuses.
  // Provisional strategies auto-promote once minLiveTrades accumulates.
  if (strategy.status !== "active" && strategy.status !== "provisional") return false;

  // ── Try live score first (best data) ──────────────────
  const liveScore = normalizeRate(strategy.scores?.live);
  const liveTrades = Number(strategy.evidence?.live?.trades ?? strategy.scores?.liveTrades ?? 0);
  if (liveScore != null && liveTrades >= cfg.minLiveTradesForOverride) {
    return liveScore >= cfg.minLiveScoreForOverride;
  }

  // ── Fallback to paper score if live data is too thin ──
  const paperScore = normalizeRate(strategy.scores?.paper);
  const paperTrades = Number(strategy.evidence?.paper?.trades ?? strategy.scores?.paperTrades ?? 0);
  if (paperScore != null && paperTrades >= cfg.minPaperTradesForOverride) {
    return paperScore >= cfg.minPaperScoreForOverride;
  }

  // ── Fallback to backtest score if no paper/live data ──
  const backtestScore = normalizeRate(strategy.scores?.backtest);
  const backtestTrades = Number(strategy.evidence?.backtest?.trades ?? strategy.scores?.backtestTrades ?? 0);
  if (backtestScore != null && backtestTrades >= cfg.minBacktestTradesForOverride) {
    return backtestScore >= cfg.minBacktestScoreForOverride;
  }

  // ── Provisional: no trade evidence yet, check fundamental signal ──
  if (strategy.status === "provisional") {
    const provisionalScore = normalizeRate(strategy.scores?.provisional);
    if (provisionalScore != null) {
      return provisionalScore >= (cfg.minProvisionalScoreForOverride ?? 0.65);
    }
  }

  return false;
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
      enabled:                       Boolean(cfg.enabled ?? false),
      mode:                          String(cfg.mode || "").toLowerCase() === "live" ? "live" : "shadow",
      minLiveScoreForOverride:       clampNumber(cfg.minLiveScoreForOverride, 0.85),
      minLiveTradesForOverride:      Math.max(0, Math.floor(clampNumber(cfg.minLiveTradesForOverride, 60))),
      minPaperScoreForOverride:      clampNumber(cfg.minPaperScoreForOverride, 0.82),
      minPaperTradesForOverride:     Math.max(0, Math.floor(clampNumber(cfg.minPaperTradesForOverride, 35))),
      minBacktestScoreForOverride:   clampNumber(cfg.minBacktestScoreForOverride, 0.80),
      minBacktestTradesForOverride:  Math.max(0, Math.floor(clampNumber(cfg.minBacktestTradesForOverride, 150))),
      minProvisionalScoreForOverride: clampNumber(cfg.minProvisionalScoreForOverride, 0.80),
      cacheTtlMs:                    Math.max(0, clampNumber(cfg.cacheTtlMs, DEFAULT_CACHE_TTL_MS)),
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
      this.#logger.debug?.(`runtime selector: ${strategy.id} below floor (live=${strategy.scores?.live ?? "—"}/${strategy.evidence?.live?.trades ?? 0}tr, paper=${strategy.scores?.paper ?? "—"}/${strategy.evidence?.paper?.trades ?? 0}tr, backtest=${strategy.scores?.backtest ?? "—"}/${strategy.evidence?.backtest?.trades ?? 0}tr)`);
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
