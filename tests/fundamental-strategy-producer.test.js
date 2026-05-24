import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FundamentalStrategyProducer,
  fingerprintRules,
  compositeStrength,
  collectFundamentalSnapshot,
} from "../fundamental-strategy-producer.js";
import { StrategyComposer, validateStrategyRuleSchema } from "../strategy-composer.js";
import { StrategyRegistry } from "../strategy-registry.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// Default mock: pretend the agent has been running for 60 days — bypasses
// the maturity gate so threshold/dedup/throttle tests can focus on their
// concerns. Maturity-specific behaviour is tested in its own describe block.
function makeMaturityFn(ageDays = 60) {
  return () => ({
    ageDays,
    oldestSeenAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
    sources: ["regime", "conviction"],
    mature(minDays = 30) { return ageDays >= minDays; },
  });
}

function makeMemories(overrides = {}) {
  return {
    getCoinConviction: (mint) => ({
      mint,
      conviction_score: 72,
      confidence_score: 55,
      stance: "strong",
    }),
    summarizeSmartWalletHistory: () => ({
      sample_count: 8,
      stability_score: 70,
      avg_winrate: 0.65,
      avg_realized_pnl_sol: 0.5,
    }),
    analyzeHolderStructure: () => ({
      hidden_wallet_control_score: 25,  // → quality = 75
      holder_structure_risk: "LOW",
    }),
    getRegimeAssessment: () => ({
      regime_score: 60,
      confidence_score: 45,
      stance: "tailwind",
    }),
    getNarrativeConviction: () => ({
      conviction_score: 65,
      confidence_score: 40,
      stance: "building",
    }),
    getExecutionQualityAssessment: () => ({
      quality_score: 70,
      confidence_score: 40,
      stance: "preferred",
    }),
    ...overrides,
  };
}

function makeRegistryWithTwoActive() {
  const reg = new StrategyRegistry({ persistPath: null });
  const idA = reg.register({
    name: "alpha",
    type: "manual",
    rules: { signal: "rsi", entryRsi: 30, tpPct: 50, stopPct: 20 },
    regime: "HOT",
  });
  reg.activate(idA, { live: 0.85 });
  const idB = reg.register({
    name: "beta",
    type: "manual",
    rules: { signal: "macd", entryRsi: 40, tpPct: 40, stopPct: 25 },
    regime: "HOT",
  });
  reg.activate(idB, { live: 0.82 });
  return reg;
}

function makeProducer(overrides = {}) {
  const registry = overrides.registry ?? makeRegistryWithTwoActive();
  const composer = overrides.composer ?? new StrategyComposer({ registry });
  const bus = overrides.bus ?? { enqueue: vi.fn(async () => ({ accepted: true, queueSize: 1 })) };
  const memories = overrides.memories ?? makeMemories();
  const dataMaturityFn = overrides.dataMaturityFn ?? makeMaturityFn(60);
  return {
    registry,
    composer,
    bus,
    memories,
    producer: new FundamentalStrategyProducer({
      bus,
      composer,
      registry,
      memories,
      config: { enabled: true, dryRun: false, ...(overrides.config || {}) },
      logger: overrides.logger ?? silentLogger,
      dataMaturityFn,
    }),
  };
}

describe("FundamentalStrategyProducer", () => {
  describe("fingerprintRules", () => {
    it("produces stable fingerprint regardless of key order", () => {
      const a = fingerprintRules({ signal: "rsi", tpPct: 50, stopPct: 20 });
      const b = fingerprintRules({ stopPct: 20, signal: "rsi", tpPct: 50 });
      expect(a).toBe(b);
    });

    it("returns empty string for non-object", () => {
      expect(fingerprintRules(null)).toBe("");
      expect(fingerprintRules("not-an-object")).toBe("");
    });
  });

  describe("compositeStrength", () => {
    it("weighs available scores and ignores missing", () => {
      const strength = compositeStrength({ coin_conviction: 80, holder_quality: 60 });
      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(100);
    });

    it("returns 0 when nothing available", () => {
      expect(compositeStrength({})).toBe(0);
    });
  });

  describe("collectFundamentalSnapshot", () => {
    it("aggregates all memory sources when populated", () => {
      const snapshot = collectFundamentalSnapshot({
        memories: makeMemories(),
        sampleTokens: [{ mint: "MintA", symbol: "ALPHA" }],
        sampleWallets: ["WalletA"],
      });
      expect(snapshot.sources.length).toBeGreaterThan(0);
      expect(snapshot.scores.coin_conviction).toBeGreaterThan(0);
      expect(snapshot.sampledMints).toContain("MintA");
    });

    it("degrades gracefully when memories are empty", () => {
      const snapshot = collectFundamentalSnapshot({
        memories: {},
        sampleTokens: [],
        sampleWallets: [],
      });
      expect(snapshot.sources).toEqual([]);
      expect(snapshot.sampledMints).toEqual([]);
    });

    it("survives memory functions that throw", () => {
      const memories = makeMemories({
        getCoinConviction: () => { throw new Error("boom"); },
      });
      const snapshot = collectFundamentalSnapshot({
        memories,
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: [],
      });
      // Other sources still populate.
      expect(snapshot.sources.length).toBeGreaterThan(0);
    });
  });

  describe("evaluateSignals threshold gating", () => {
    it("returns [] when conviction below threshold", () => {
      const { producer } = makeProducer({
        memories: makeMemories({
          getCoinConviction: () => ({ conviction_score: 50, confidence_score: 50 }),
        }),
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
      });
      expect(candidates).toEqual([]);
    });

    it("returns candidate when conviction + optional booster pass", () => {
      const { producer } = makeProducer({
        memories: makeMemories({
          getCoinConviction: () => ({ conviction_score: 78, confidence_score: 60 }),
          summarizeSmartWalletHistory: () => ({ sample_count: 5, stability_score: 70, avg_winrate: 0.65 }),
        }),
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].evidence?.sources).toContain("conviction-memory");
      expect(candidates[0].evidence?.scores?.composite_strength).toBeGreaterThan(0);
      expect(candidates[0].evidence?.sampledMints).toContain("MintA");
    });

    it("returns [] when no optional booster meets threshold", () => {
      const { producer } = makeProducer({
        memories: makeMemories({
          getCoinConviction: () => ({ conviction_score: 80, confidence_score: 60 }),
          summarizeSmartWalletHistory: () => ({ sample_count: 5, stability_score: 30, avg_winrate: 0.4 }),
          analyzeHolderStructure: () => ({ hidden_wallet_control_score: 80 }),  // quality=20
          getRegimeAssessment: () => ({ regime_score: 30, confidence_score: 30 }),
        }),
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
      });
      expect(candidates).toEqual([]);
    });
  });

  describe("disabled producer", () => {
    it("returns [] from evaluateSignals when enabled=false", () => {
      const { producer } = makeProducer({ config: { enabled: false } });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
      });
      expect(candidates).toEqual([]);
    });

    it("start() is no-op when disabled", () => {
      const { producer } = makeProducer({ config: { enabled: false } });
      producer.start();
      expect(producer.running).toBe(false);
    });
  });

  describe("schema-valid candidate output", () => {
    it("composed candidate passes validateStrategyRuleSchema", () => {
      const { producer } = makeProducer();
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(candidates.length).toBeGreaterThan(0);
      const composed = candidates.find(c => c.type === "compose");
      expect(composed).toBeTruthy();
      expect(validateStrategyRuleSchema(composed.rules)).toBe(true);
    });

    it("composed candidate has evidence with required fields", () => {
      const { producer } = makeProducer();
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
      });
      const composed = candidates.find(c => c.type === "compose");
      expect(composed.evidence.sources.length).toBeGreaterThan(0);
      expect(composed.evidence.scores).toHaveProperty("composite_strength");
      expect(Array.isArray(composed.evidence.sampledMints)).toBe(true);
    });
  });

  describe("dryRun behavior", () => {
    it("dryRun=true logs candidate but does NOT enqueue", async () => {
      const calls = [];
      const logger = {
        info: (msg) => calls.push(msg),
        warn: () => {}, error: () => {},
      };
      const { producer, bus } = makeProducer({
        config: { dryRun: true },
        logger,
      });
      const emitted = await producer.tick({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(emitted.length).toBeGreaterThan(0);
      expect(bus.enqueue).not.toHaveBeenCalled();
      expect(calls.some(msg => /fundamental_producer_dryrun/.test(String(msg)))).toBe(true);
    });

    it("dryRun=false enqueues to bus", async () => {
      const { producer, bus } = makeProducer({ config: { dryRun: false } });
      const emitted = await producer.tick({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(emitted.length).toBeGreaterThan(0);
      expect(bus.enqueue).toHaveBeenCalled();
    });
  });

  describe("dedup + throttling", () => {
    it("skips identical fingerprint within dedup window", async () => {
      const { producer, bus } = makeProducer({
        config: { dryRun: false, dedupWindowMin: 30 },
      });
      await producer.tick({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      await producer.tick({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      // Second tick should hit dedup → only 1 enqueue total.
      expect(bus.enqueue).toHaveBeenCalledTimes(1);
    });

    it("respects maxPerHour throttle", async () => {
      const { producer, bus, registry, composer } = makeProducer({
        config: { dryRun: false, maxPerHour: 1, dedupWindowMin: 1 },
      });
      // First tick emits.
      await producer.tick({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      // Second tick with DIFFERENT rule fingerprint via a new active strategy.
      const idC = registry.register({
        name: "gamma",
        type: "manual",
        rules: { signal: "vol", entryRsi: 25, tpPct: 80, stopPct: 15 },
        regime: "HOT",
      });
      registry.activate(idC, { live: 0.9 });
      await producer.tick({
        sampleTokens: [{ mint: "MintB" }],
        sampleWallets: ["WalletB"],
        regime: "HOT",
      });
      expect(bus.enqueue).toHaveBeenCalledTimes(1);  // throttled
    });
  });

  describe("compose-first / generate-fallback", () => {
    it("does not call composer.generate when ≥2 active strategies exist", async () => {
      const generateSpy = vi.fn();
      const { producer } = makeProducer({
        composer: Object.assign(new StrategyComposer({ registry: makeRegistryWithTwoActive() }), {
          generate: generateSpy,
        }),
      });
      await producer.tick({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(generateSpy).not.toHaveBeenCalled();
    });

    it("attempts composer.generate when registry below threshold", async () => {
      const emptyRegistry = new StrategyRegistry({ persistPath: null });
      const generateSpy = vi.fn(async () => ({
        type: "generate",
        name: "llm-fallback",
        rules: { signal: "vol-breakout", tpPct: 80, stopPct: 15 },
        regime: "HOT",
        source: "llm",
      }));
      const composer = Object.assign(new StrategyComposer({ registry: emptyRegistry }), {
        generate: generateSpy,
      });
      const { producer, bus } = makeProducer({
        registry: emptyRegistry,
        composer,
        config: { dryRun: false, llmFallbackMinActive: 2 },
      });
      await producer.tick({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(generateSpy).toHaveBeenCalled();
      expect(bus.enqueue).toHaveBeenCalled();
    });
  });

  describe("data maturity gate", () => {
    it("rejects emission when agent data age < minDataAgeDays", async () => {
      const { producer, bus } = makeProducer({
        dataMaturityFn: makeMaturityFn(5),  // 5 days only
        config: { dryRun: false, minDataAgeDays: 30 },
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(candidates).toEqual([]);
      const emitted = await producer.tick({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(emitted).toEqual([]);
      expect(bus.enqueue).not.toHaveBeenCalled();
    });

    it("allows emission once age threshold is met", () => {
      const { producer } = makeProducer({
        dataMaturityFn: makeMaturityFn(45),
        config: { minDataAgeDays: 30 },
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].evidence.maturity.ageDays).toBeGreaterThanOrEqual(45);
    });

    it("minDataAgeDays=0 disables the gate entirely", () => {
      const { producer } = makeProducer({
        dataMaturityFn: makeMaturityFn(1),
        config: { minDataAgeDays: 0 },
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(candidates.length).toBeGreaterThan(0);
    });

    it("getMaturityStatus exposes current age + required threshold", () => {
      const { producer } = makeProducer({
        dataMaturityFn: makeMaturityFn(12),
        config: { minDataAgeDays: 30 },
      });
      const status = producer.getMaturityStatus();
      expect(status.ageDays).toBe(12);
      expect(status.required).toBe(30);
      expect(status.mature).toBe(false);
    });

    it("survives when dataMaturityFn throws", () => {
      const { producer } = makeProducer({
        dataMaturityFn: () => { throw new Error("memory store missing"); },
        config: { minDataAgeDays: 30 },
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
      });
      expect(candidates).toEqual([]);
    });

    it("evidence object carries maturity metadata", () => {
      const { producer } = makeProducer({
        dataMaturityFn: makeMaturityFn(60),
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
        regime: "HOT",
      });
      expect(candidates[0].evidence.maturity).toMatchObject({
        ageDays: 60,
        sources: expect.arrayContaining(["regime"]),
      });
      expect(candidates[0].evidence.maturity.oldestSeenAt).toBeTruthy();
    });
  });

  describe("graceful failure modes", () => {
    it("survives missing composer", () => {
      const registry = makeRegistryWithTwoActive();
      const producer = new FundamentalStrategyProducer({
        bus: { enqueue: vi.fn() },
        composer: null,
        registry,
        memories: makeMemories(),
        config: { enabled: true, dryRun: true },
        logger: silentLogger,
      });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
      });
      expect(candidates).toEqual([]);
    });

    it("survives empty memories without throwing", () => {
      const { producer } = makeProducer({ memories: {} });
      const candidates = producer.evaluateSignals({
        sampleTokens: [{ mint: "MintA" }],
        sampleWallets: ["WalletA"],
      });
      expect(candidates).toEqual([]);
    });
  });
});
