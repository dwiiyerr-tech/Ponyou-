import { describe, it, expect, vi } from "vitest";
import { StrategyComposer, validateStrategyRuleSchema } from "../strategy-composer.js";
import { StrategyRegistry } from "../strategy-registry.js";

describe("StrategyComposer", () => {
  it("selectBest returns active strategy for regime", () => {
    const reg = new StrategyRegistry({ persistPath: null });
    const id = reg.register({ name: "hot-strat", type: "select", rules: { signal: "three_candle" }, regime: "HOT" });
    reg.activate(id, { live: 0.88 });
    const composer = new StrategyComposer({ registry: reg });
    const best = composer.selectBest("HOT");
    expect(best?.name).toBe("hot-strat");
  });

  it("returns null when no active strategy for regime", () => {
    const reg = new StrategyRegistry({ persistPath: null });
    const composer = new StrategyComposer({ registry: reg });
    expect(composer.selectBest("DEAD")).toBeNull();
  });

  it("compose merges two strategies conservatively", () => {
    const composer = new StrategyComposer({ registry: new StrategyRegistry({ persistPath: null }) });
    const stratA = { id: "a1", name: "alpha", regime: "HOT", rules: { entryRsi: 30, tpPct: 50, signal: "rsi" } };
    const stratB = { id: "b1", name: "beta", regime: "HOT", rules: { entryRsi: 40, tpPct: 40, signal: "macd" } };
    const candidate = composer.compose(stratA, stratB);
    expect(candidate.type).toBe("compose");
    expect(candidate.name).toBe("a1+b1-hybrid");
    expect(candidate.regime).toBe("HOT");
    expect(candidate.parents).toEqual(["a1", "b1"]);
    expect(candidate.rules.entryRsi).toBe(40);
    expect(candidate.rules.tpPct).toBe(40);
    expect(candidate.rules.signal).toEqual(["rsi", "macd"]);
  });

  it("compose rejects malformed parent strategies", () => {
    const composer = new StrategyComposer({ registry: new StrategyRegistry({ persistPath: null }) });
    expect(() => composer.compose({ id: "a1" }, { id: "b1", rules: { signal: "macd" } }))
      .toThrow("requires two strategies with rules");
  });

  it("generate validates LLM output schema and returns candidate", async () => {
    const mockLlm = vi.fn(async () => ({ name: "llm-strat", signal: "breakout", entryRsi: 35, tpPct: 60 }));
    const composer = new StrategyComposer({
      registry: new StrategyRegistry({ persistPath: null }),
      llmGenerator: mockLlm,
    });
    const candidate = await composer.generate({ regime: "HOT", context: {} });
    expect(candidate.type).toBe("generate");
    expect(candidate.name).toBe("llm-strat");
    expect(candidate.regime).toBe("HOT");
    expect(candidate.rules.signal).toBe("breakout");
    expect(candidate.rules.name).toBeUndefined();
    expect(mockLlm).toHaveBeenCalledWith({ regime: "HOT", context: {} });
  });

  it("generate accepts nested rules and generated JSON strings", async () => {
    const mockLlm = vi.fn(async () => JSON.stringify({
      name: "nested-strat",
      regime: "WARM",
      rules: { signal: "three_candle", entryRsi: 45, stopPct: 12 },
    }));
    const composer = new StrategyComposer({
      registry: new StrategyRegistry({ persistPath: null }),
      llmGenerator: mockLlm,
    });

    const candidate = await composer.generate({ regime: "HOT" });

    expect(candidate.name).toBe("nested-strat");
    expect(candidate.regime).toBe("WARM");
    expect(candidate.rules).toEqual({ signal: "three_candle", entryRsi: 45, stopPct: 12 });
  });

  it("generate returns null when LLM output fails schema validation", async () => {
    const mockLlm = vi.fn(async () => ({ invalid: true }));
    const composer = new StrategyComposer({
      registry: new StrategyRegistry({ persistPath: null }),
      llmGenerator: mockLlm,
    });
    const candidate = await composer.generate({ regime: "HOT", context: {} });
    expect(candidate).toBeNull();
  });

  it("generate rejects BUY/SELL action payloads before they enter the gate", async () => {
    const mockLlm = vi.fn(async () => ({ name: "unsafe", signal: "breakout", action: "BUY" }));
    const composer = new StrategyComposer({
      registry: new StrategyRegistry({ persistPath: null }),
      llmGenerator: mockLlm,
    });
    await expect(composer.generate({ regime: "HOT" })).resolves.toBeNull();
    expect(validateStrategyRuleSchema({ signal: "SELL" })).toBe(false);
  });

  it("generate rejects invalid numeric risk thresholds", async () => {
    const mockLlm = vi.fn(async () => ({ signal: "breakout", entryRsi: 101, stopPct: 0 }));
    const composer = new StrategyComposer({
      registry: new StrategyRegistry({ persistPath: null }),
      llmGenerator: mockLlm,
    });
    await expect(composer.generate({ regime: "HOT" })).resolves.toBeNull();
  });

  it("generate returns null when llmGenerator throws", async () => {
    const mockLlm = vi.fn(async () => { throw new Error("LLM timeout"); });
    const composer = new StrategyComposer({
      registry: new StrategyRegistry({ persistPath: null }),
      llmGenerator: mockLlm,
    });
    const candidate = await composer.generate({ regime: "HOT", context: {} });
    expect(candidate).toBeNull();
  });
});
