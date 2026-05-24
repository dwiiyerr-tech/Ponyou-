/**
 * fundamental-strategy-producer.js
 *
 * Bridges fundamental signals (conviction / smart-wallet / holder / regime
 * / narrative / execution quality) → StrategyComposer → StrategyEvolutionBus.
 *
 * Phase-1 scope per task #1 research:
 *  - Fundamental signals only drive PARENT SELECTION for compose(); they do
 *    NOT become entry rules. So composed candidates inherit rules from two
 *    top active strategies in the registry — fundamentals just decide *when*
 *    to compose and how to bias picking.
 *  - LLM generate() path is throttled (default 1×/24h) and only fires when
 *    the registry has fewer than `llmFallbackMinActive` active strategies.
 *  - dryRun=true: log candidate but do not enqueue. Default true.
 *
 * Contracts respected:
 *  - candidate.rules MUST satisfy validateStrategyRuleSchema (signal field
 *    required, no BUY/SELL action). When compose() inherits rules from
 *    parents that already meet the schema, this holds by construction.
 *  - Read-only against conviction-memory / holder-memory / smart-wallet-history
 *    / regime-memory / narrative-contagion / execution-quality-memory.
 *  - Throttle + dedup to avoid spamming the proposal channel.
 */

import { validateStrategyRuleSchema } from "./strategy-composer.js";
import { getDataMaturity } from "./data-maturity.js";

const DEFAULT_LOGGER = {
  info: (...args) => console.log("[fundamental-producer]", ...args),
  warn: (...args) => console.warn("[fundamental-producer]", ...args),
  error: (...args) => console.error("[fundamental-producer]", ...args),
};

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function clampNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fingerprint a candidate's rules for dedup. Stable across reorderings.
 */
function fingerprintRules(rules = {}) {
  if (!isPlainObject(rules)) return "";
  const keys = Object.keys(rules).sort();
  return keys
    .map(key => `${key}=${JSON.stringify(rules[key])}`)
    .join("|");
}

/**
 * Aggregate fundamental signals into a single conviction read. Read-only
 * against memories. Each branch is wrapped in try/catch so the producer
 * never throws when a memory store is missing or malformed.
 */
function collectFundamentalSnapshot({ memories, sampleTokens = [], sampleWallets = [] }) {
  const sources = [];
  const scores = {};
  const sampledMints = [];
  const sampledWallets = [];

  // ── Coin conviction ────────────────────────────────────────────────
  if (typeof memories?.getCoinConviction === "function" && Array.isArray(sampleTokens)) {
    try {
      const convictions = sampleTokens
        .filter(token => token?.mint)
        .map(token => {
          const conv = memories.getCoinConviction(token.mint, token);
          if (conv && conv.conviction_score > 0) sampledMints.push(token.mint);
          return conv;
        })
        .filter(Boolean);
      if (convictions.length > 0) {
        const avg = convictions.reduce((s, c) => s + clampNumber(c.conviction_score), 0) / convictions.length;
        const confidence = convictions.reduce((s, c) => s + clampNumber(c.confidence_score), 0) / convictions.length;
        scores.coin_conviction = Number(avg.toFixed(2));
        scores.coin_confidence = Number(confidence.toFixed(2));
        sources.push("conviction-memory");
      }
    } catch {}
  }

  // ── Smart wallet stability ─────────────────────────────────────────
  if (typeof memories?.summarizeSmartWalletHistory === "function" && Array.isArray(sampleWallets)) {
    try {
      const summaries = sampleWallets
        .filter(addr => typeof addr === "string" && addr.length > 0)
        .map(addr => {
          const s = memories.summarizeSmartWalletHistory(addr, { timeframe: "24h", limit: 12 });
          if (s && s.sample_count > 0) sampledWallets.push(addr);
          return s;
        })
        .filter(s => s && s.sample_count > 0);
      if (summaries.length > 0) {
        const avgStability = summaries.reduce((s, x) => s + clampNumber(x.stability_score), 0) / summaries.length;
        const avgWinrate = summaries.reduce((s, x) => s + clampNumber(x.avg_winrate), 0) / summaries.length;
        scores.smart_wallet_stability = Number(avgStability.toFixed(2));
        scores.smart_wallet_winrate = Number(avgWinrate.toFixed(3));
        sources.push("smart-wallet-history");
      }
    } catch {}
  }

  // ── Holder quality ─────────────────────────────────────────────────
  if (typeof memories?.analyzeHolderStructure === "function" && Array.isArray(sampleTokens)) {
    try {
      const structures = sampleTokens
        .map(token => {
          try {
            return memories.analyzeHolderStructure({
              rugSignals: token.rug_signals || token.rugSignals || {},
              holders: token.holders || [],
              token,
            });
          } catch { return null; }
        })
        .filter(Boolean);
      if (structures.length > 0) {
        // Holder *quality* = inverse of hidden control. Higher is better.
        const avgHidden = structures.reduce((s, x) => s + clampNumber(x.hidden_wallet_control_score, 0), 0) / structures.length;
        const quality = Math.max(0, 100 - avgHidden);
        scores.holder_quality = Number(quality.toFixed(2));
        sources.push("holder-memory");
      }
    } catch {}
  }

  // ── Regime fit ─────────────────────────────────────────────────────
  if (typeof memories?.getRegimeAssessment === "function" && Array.isArray(sampleTokens)) {
    try {
      const regimes = sampleTokens
        .map(token => {
          try { return memories.getRegimeAssessment(token); }
          catch { return null; }
        })
        .filter(r => r && (r.confidence_score || 0) >= 20);
      if (regimes.length > 0) {
        const avgRegime = regimes.reduce((s, r) => s + clampNumber(r.regime_score), 0) / regimes.length;
        scores.regime_score = Number(avgRegime.toFixed(2));
        sources.push("regime-memory");
      }
    } catch {}
  }

  // ── Narrative conviction (cluster-level) ───────────────────────────
  if (typeof memories?.getNarrativeConviction === "function" && Array.isArray(sampleTokens)) {
    try {
      const seen = new Set();
      const narrativeScores = [];
      for (const token of sampleTokens) {
        const cluster = token?.conviction?.narrative_cluster?.narrative
          || (Array.isArray(token?.narrative_tags) && (typeof token.narrative_tags[0] === "string" ? token.narrative_tags[0] : token.narrative_tags[0]?.narrative))
          || null;
        if (!cluster || seen.has(cluster)) continue;
        seen.add(cluster);
        const narrative = memories.getNarrativeConviction(cluster);
        if (narrative && narrative.confidence_score >= 20) {
          narrativeScores.push(narrative.conviction_score);
        }
      }
      if (narrativeScores.length > 0) {
        const avg = narrativeScores.reduce((s, x) => s + x, 0) / narrativeScores.length;
        scores.narrative_conviction = Number(avg.toFixed(2));
        sources.push("narrative-conviction");
      }
    } catch {}
  }

  // ── Execution quality (preferred route) ────────────────────────────
  if (typeof memories?.getExecutionQualityAssessment === "function") {
    try {
      const assessment = memories.getExecutionQualityAssessment({
        marketCondition: scores.regime_score >= 60 ? "HOT" : "UNKNOWN",
      });
      if (assessment && assessment.confidence_score >= 18) {
        scores.execution_quality = Number(assessment.quality_score.toFixed(2));
        sources.push("execution-quality");
      }
    } catch {}
  }

  return { sources, scores, sampledMints, sampledWallets };
}

/**
 * Compute composite fundamental strength 0-100 from snapshot scores.
 */
function compositeStrength(scores = {}) {
  const weights = {
    coin_conviction:        0.30,
    smart_wallet_stability: 0.25,
    holder_quality:         0.20,
    regime_score:           0.15,
    narrative_conviction:   0.10,
  };
  let totalWeight = 0;
  let weighted = 0;
  for (const [key, w] of Object.entries(weights)) {
    if (Number.isFinite(scores[key])) {
      weighted += scores[key] * w;
      totalWeight += w;
    }
  }
  if (totalWeight === 0) return 0;
  return Number((weighted / totalWeight).toFixed(2));
}

export class FundamentalStrategyProducer {
  #bus;
  #composer;
  #registry;
  #memories;
  #config;
  #logger;
  #dataMaturityFn;
  #emitHistory = [];   // [{ts, fingerprint}]
  #lastLlmAt = 0;
  #intervalHandle = null;
  #running = false;
  #lastMaturity = null;

  constructor({ bus, composer, registry, memories = {}, config = {}, logger = DEFAULT_LOGGER, dataMaturityFn = getDataMaturity } = {}) {
    this.#bus = bus;
    this.#composer = composer;
    this.#registry = registry;
    this.#memories = memories;
    this.#config = this.#normalizeConfig(config);
    this.#logger = logger || DEFAULT_LOGGER;
    this.#dataMaturityFn = dataMaturityFn;
  }

  #normalizeConfig(cfg = {}) {
    return {
      enabled:                Boolean(cfg.enabled ?? false),
      dryRun:                 Boolean(cfg.dryRun ?? true),
      intervalMin:            clampNumber(cfg.intervalMin, 30),
      minDataAgeDays:         Math.max(0, clampNumber(cfg.minDataAgeDays, 30)),
      minConviction:          clampNumber(cfg.minConviction, 68),
      minConfidence:          clampNumber(cfg.minConfidence, 40),
      minSmartWalletStability:clampNumber(cfg.minSmartWalletStability, 55),
      minHolderQualityScore:  clampNumber(cfg.minHolderQualityScore, 40),
      minRegimeScore:         clampNumber(cfg.minRegimeScore, 50),
      maxPerHour:             Math.max(1, Math.floor(clampNumber(cfg.maxPerHour, 3))),
      dedupWindowMin:         Math.max(1, Math.floor(clampNumber(cfg.dedupWindowMin, 30))),
      llmCooldownHours:       Math.max(0, clampNumber(cfg.llmCooldownHours, 24)),
      llmFallbackMinActive:   Math.max(0, Math.floor(clampNumber(cfg.llmFallbackMinActive, 2))),
    };
  }

  get config() { return { ...this.#config }; }
  get running() { return this.#running; }
  get lastMaturity() { return this.#lastMaturity ? { ...this.#lastMaturity } : null; }

  /**
   * Snapshot current data maturity without running a full evaluation cycle.
   * Useful for the dashboard / Telegram status command.
   */
  getMaturityStatus() {
    try {
      const m = this.#dataMaturityFn();
      this.#lastMaturity = m;
      return {
        ageDays: m.ageDays,
        oldestSeenAt: m.oldestSeenAt,
        sources: m.sources,
        required: this.#config.minDataAgeDays,
        mature: m.mature(this.#config.minDataAgeDays),
      };
    } catch (err) {
      return { ageDays: 0, oldestSeenAt: null, sources: [], required: this.#config.minDataAgeDays, mature: false, error: err?.message || String(err) };
    }
  }

  /**
   * Start periodic evaluation. The caller (index.js) is expected to drive
   * sampleTokens / sampleWallets via setContext or pass them on each tick.
   * For simplicity we expose a manual tick() the orchestrator can call from
   * its own screening cron.
   */
  start({ intervalMs = null, contextProvider = null } = {}) {
    if (this.#running) return;
    if (!this.#config.enabled) {
      this.#logger.info?.("producer disabled — skipping start");
      return;
    }
    this.#running = true;
    const tickInterval = Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : this.#config.intervalMin * MINUTE_MS;
    if (typeof contextProvider === "function") {
      this.#intervalHandle = setInterval(async () => {
        try {
          const context = await contextProvider();
          await this.tick(context || {});
        } catch (err) {
          this.#logger.error?.(`tick failed: ${err?.message || err}`);
        }
      }, tickInterval);
      // Don't keep the process alive solely because of this timer.
      if (this.#intervalHandle?.unref) this.#intervalHandle.unref();
    }
    this.#logger.info?.(`started (dryRun=${this.#config.dryRun}, intervalMin=${this.#config.intervalMin})`);
  }

  stop() {
    this.#running = false;
    if (this.#intervalHandle) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  /**
   * Manual evaluation entry. context = { sampleTokens, sampleWallets, regime }.
   * Returns array of candidate objects actually emitted (or logged in dryRun).
   */
  async tick(context = {}) {
    if (!this.#config.enabled) return [];
    const candidates = this.evaluateSignals(context);
    const emitted = [];
    for (const candidate of candidates) {
      const ok = await this.#emit(candidate);
      if (ok) emitted.push(candidate);
    }
    return emitted;
  }

  /**
   * Pure(ish) evaluation — reads memories, decides whether thresholds pass,
   * returns 0+ candidate objects. Read-only against memories.
   */
  evaluateSignals(context = {}) {
    if (!this.#config.enabled) return [];

    // ── Maturity gate ──────────────────────────────────────────────────
    // The agent must have been collecting data for at least minDataAgeDays
    // before its memory layer is trustworthy enough to drive strategy
    // evolution. This prevents the producer from emitting strategies
    // grounded in 2 days of noisy observations.
    let maturity;
    try {
      maturity = this.#dataMaturityFn();
    } catch (err) {
      this.#logger.warn?.(`data-maturity probe failed: ${err?.message || err}`);
      return [];
    }
    this.#lastMaturity = maturity;
    if (this.#config.minDataAgeDays > 0 && !maturity.mature(this.#config.minDataAgeDays)) {
      this.#logger.info?.(`data immature: ageDays=${maturity.ageDays} < required=${this.#config.minDataAgeDays}`);
      return [];
    }

    let snapshot;
    try {
      snapshot = collectFundamentalSnapshot({
        memories: this.#memories,
        sampleTokens: Array.isArray(context.sampleTokens) ? context.sampleTokens : [],
        sampleWallets: Array.isArray(context.sampleWallets) ? context.sampleWallets : [],
      });
    } catch (err) {
      this.#logger.warn?.(`snapshot failed: ${err?.message || err}`);
      return [];
    }

    if (!snapshot || snapshot.sources.length === 0) {
      // No memory has populated data yet — degrade gracefully.
      return [];
    }

    const passes = this.#thresholdPasses(snapshot.scores);
    if (!passes.passed) {
      this.#logger.info?.(`thresholds not met: ${passes.reason}`);
      return [];
    }

    if (!this.#throttleAllows()) {
      this.#logger.info?.(`throttled — already emitted ${this.#config.maxPerHour}/hr`);
      return [];
    }

    const composite = compositeStrength(snapshot.scores);
    const evidence = {
      sources: snapshot.sources,
      scores: { ...snapshot.scores, composite_strength: composite },
      sampledMints: snapshot.sampledMints,
      sampledWallets: snapshot.sampledWallets,
      regime: context.regime || null,
      maturity: {
        ageDays: maturity?.ageDays ?? 0,
        oldestSeenAt: maturity?.oldestSeenAt ?? null,
        sources: maturity?.sources ?? [],
      },
      generatedAt: new Date().toISOString(),
    };

    const candidates = [];
    const composed = this.#buildComposedCandidate({ evidence, regime: context.regime });
    if (composed) candidates.push(composed);

    const llmCandidate = this.#maybeBuildLlmCandidate({ evidence, regime: context.regime });
    if (llmCandidate) candidates.push(llmCandidate);

    return candidates;
  }

  // ── Internals ─────────────────────────────────────────────────────

  #thresholdPasses(scores = {}) {
    const minConviction = this.#config.minConviction;
    const conviction = Number.isFinite(scores.coin_conviction) ? scores.coin_conviction : null;
    if (conviction == null || conviction < minConviction) {
      return { passed: false, reason: `coin_conviction ${conviction ?? "n/a"} < ${minConviction}` };
    }
    const confidence = Number.isFinite(scores.coin_confidence) ? scores.coin_confidence : 0;
    if (confidence < this.#config.minConfidence) {
      return { passed: false, reason: `coin_confidence ${confidence} < ${this.#config.minConfidence}` };
    }
    // Stability/holder/regime are optional boosters — pass if at least ONE
    // of them clears its threshold (avoid all-or-nothing in early Phase 1).
    const optional = [
      ["smart_wallet_stability", this.#config.minSmartWalletStability],
      ["holder_quality",         this.#config.minHolderQualityScore],
      ["regime_score",           this.#config.minRegimeScore],
    ];
    const optionalHit = optional.some(([key, threshold]) =>
      Number.isFinite(scores[key]) && scores[key] >= threshold);
    if (!optionalHit) {
      return { passed: false, reason: "no optional fundamental booster met threshold" };
    }
    return { passed: true };
  }

  #throttleAllows() {
    const now = Date.now();
    this.#emitHistory = this.#emitHistory.filter(entry => now - entry.ts < HOUR_MS);
    return this.#emitHistory.length < this.#config.maxPerHour;
  }

  #isDuplicate(fingerprint) {
    const now = Date.now();
    const windowMs = this.#config.dedupWindowMin * MINUTE_MS;
    return this.#emitHistory.some(entry =>
      entry.fingerprint === fingerprint && now - entry.ts < windowMs);
  }

  #buildComposedCandidate({ evidence, regime }) {
    if (!this.#composer || typeof this.#composer.compose !== "function") return null;
    if (!this.#registry || typeof this.#registry.getAll !== "function") return null;

    const active = this.#registry.getAll().filter(s => s?.status === "active");
    if (active.length < 2) return null;

    const sorted = [...active].sort((a, b) => {
      const aScore = clampNumber(a.scores?.live ?? a.scores?.winRate ?? a.scores?.paper ?? 0);
      const bScore = clampNumber(b.scores?.live ?? b.scores?.winRate ?? b.scores?.paper ?? 0);
      return bScore - aScore;
    });
    const [parentA, parentB] = sorted;

    let composed;
    try {
      composed = this.#composer.compose(parentA, parentB, {
        regime: regime ?? null,
        reason: "fundamental-signal trigger",
      });
    } catch (err) {
      this.#logger.warn?.(`composer.compose failed: ${err?.message || err}`);
      return null;
    }

    if (!composed || !isPlainObject(composed.rules)) return null;
    if (!validateStrategyRuleSchema(composed.rules)) {
      // Parent rules must already satisfy schema — defense in depth.
      if (!validateStrategyRuleSchema({ ...composed.rules, signal: composed.rules?.signal ?? "fundamental-strong" })) {
        this.#logger.warn?.("composed candidate failed schema validation; skipping");
        return null;
      }
      composed.rules = { ...composed.rules, signal: composed.rules?.signal ?? "fundamental-strong" };
    }

    return {
      ...composed,
      evidence,
      conviction: evidence.scores.composite_strength,
    };
  }

  #maybeBuildLlmCandidate({ evidence, regime }) {
    if (!this.#composer || typeof this.#composer.generate !== "function") return null;
    if (!this.#registry || typeof this.#registry.getAll !== "function") return null;
    const active = this.#registry.getAll().filter(s => s?.status === "active");
    if (active.length >= this.#config.llmFallbackMinActive) return null;

    const now = Date.now();
    const cooldownMs = this.#config.llmCooldownHours * HOUR_MS;
    if (cooldownMs > 0 && this.#lastLlmAt && now - this.#lastLlmAt < cooldownMs) return null;
    this.#lastLlmAt = now;

    // generate() is async; the producer signature is sync, so we surface a
    // placeholder marker and let #emit await it. Callers should treat the
    // returned object's `pending` flag as "needs LLM resolution".
    return {
      type: "llm-pending",
      name: "llm-generated-pending",
      pending: true,
      regime: regime ?? null,
      evidence,
      conviction: evidence.scores.composite_strength,
    };
  }

  async #emit(candidate) {
    if (!candidate) return false;

    // Resolve pending LLM candidates.
    if (candidate.pending && typeof this.#composer?.generate === "function") {
      try {
        const generated = await this.#composer.generate({
          regime: candidate.regime,
          evidence: candidate.evidence,
        });
        if (!generated || !validateStrategyRuleSchema(generated.rules)) return false;
        candidate = { ...generated, evidence: candidate.evidence, conviction: candidate.conviction };
      } catch (err) {
        this.#logger.warn?.(`composer.generate failed: ${err?.message || err}`);
        return false;
      }
    }

    const fingerprint = fingerprintRules(candidate.rules);
    if (!fingerprint) return false;
    if (this.#isDuplicate(fingerprint)) {
      this.#logger.info?.(`dedup hit — skipping fingerprint=${fingerprint.slice(0, 64)}`);
      return false;
    }
    if (!this.#throttleAllows()) return false;

    this.#emitHistory.push({ ts: Date.now(), fingerprint });

    if (this.#config.dryRun) {
      this.#logger.info?.(`fundamental_producer_dryrun candidate=${JSON.stringify({
        name: candidate.name,
        type: candidate.type,
        rules: candidate.rules,
        conviction: candidate.conviction,
        evidence_sources: candidate.evidence?.sources,
      })}`);
      return true;
    }

    if (!this.#bus || typeof this.#bus.enqueue !== "function") {
      this.#logger.warn?.("bus.enqueue unavailable — dropping candidate");
      return false;
    }
    try {
      await this.#bus.enqueue(candidate);
      this.#logger.info?.(`enqueued candidate name=${candidate.name}`);
      return true;
    } catch (err) {
      this.#logger.error?.(`bus.enqueue failed: ${err?.message || err}`);
      return false;
    }
  }

  // For tests/operator inspection.
  _peekState() {
    return {
      emitHistory: [...this.#emitHistory],
      lastLlmAt: this.#lastLlmAt,
      running: this.#running,
    };
  }

  _resetForTests() {
    this.#emitHistory = [];
    this.#lastLlmAt = 0;
  }
}

export { fingerprintRules, compositeStrength, collectFundamentalSnapshot };
