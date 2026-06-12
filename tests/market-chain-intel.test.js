import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTEL_FILE = process.env.PONYOU_CHAIN_INTEL_FILE || path.join(__dirname, "..", "market-chain-intel.json");

function clean() {
  try { fs.unlinkSync(INTEL_FILE); } catch {}
}

// recordChainSnapshot persists fire-and-forget under a file lock; give the
// microtask/IO queue a tick to flush before reading.
const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(clean);
afterEach(clean);

// Helper builders for normalized GMGN trending rows.
const hotTokens = (chain = "sol") =>
  Array.from({ length: 10 }, (_, i) => ({
    address: `${chain}-hot-${i}`,
    swaps: 4000,
    volume: 200_000,
    buy_vol: 80_000,
    sell_vol: 20_000, // buy_ratio 0.8
  }));

const coldTokens = (chain = "sol") =>
  Array.from({ length: 5 }, (_, i) => ({
    address: `${chain}-cold-${i}`,
    swaps: 10,
    volume: 500,
    buy_vol: 100,
    sell_vol: 400,
  }));

describe("market-chain-intel — scoreChainActivity (pure)", () => {
  it("returns HOT/EXTREME for high-swaps high-buy tokens", async () => {
    const { scoreChainActivity } = await import("../market-chain-intel.js");
    const r = scoreChainActivity("sol", hotTokens());
    expect(["HOT", "EXTREME"]).toContain(r.condition);
    expect(r.score).toBeGreaterThan(40);
    expect(r.metrics.avg_swaps).toBe(4000);
    expect(r.metrics.buy_ratio).toBeCloseTo(0.8, 2);
  });

  it("returns COLD/DEAD for low-swaps tokens", async () => {
    const { scoreChainActivity } = await import("../market-chain-intel.js");
    const r = scoreChainActivity("bsc", coldTokens());
    expect(["COLD", "DEAD"]).toContain(r.condition);
    expect(r.score).toBeLessThan(40);
  });

  it("returns DEAD with score 0 for empty token list", async () => {
    const { scoreChainActivity } = await import("../market-chain-intel.js");
    const r = scoreChainActivity("eth", []);
    expect(r.condition).toBe("DEAD");
    expect(r.score).toBe(0);
    expect(r.metrics.token_count).toBe(0);
  });

  it("applies a -10 penalty per active rug dev", async () => {
    const { scoreChainActivity } = await import("../market-chain-intel.js");
    const base = scoreChainActivity("sol", hotTokens(), 0);
    const penalized = scoreChainActivity("sol", hotTokens(), 3);
    expect(base.score - penalized.score).toBe(30);
    expect(penalized.metrics.rug_active_count).toBe(3);
  });

  it("clamps score to the 0-100 range", async () => {
    const { scoreChainActivity } = await import("../market-chain-intel.js");
    const r = scoreChainActivity("sol", coldTokens(), 50); // huge rug penalty
    expect(r.score).toBe(0);
  });
});

describe("market-chain-intel — record + read", () => {
  it("rankChainsByActivity returns chains sorted by score DESC", async () => {
    const mod = await import("../market-chain-intel.js");
    mod.recordChainSnapshot("sol", hotTokens("sol"), 0);
    mod.recordChainSnapshot("bsc", coldTokens("bsc"), 0);
    await flush();
    const ranked = mod.rankChainsByActivity();
    expect(ranked.length).toBe(2);
    expect(ranked[0].chain).toBe("sol");
    expect(ranked[1].chain).toBe("bsc");
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it("getHottestChain returns the highest-scoring non-dead chain", async () => {
    const mod = await import("../market-chain-intel.js");
    mod.recordChainSnapshot("sol", coldTokens("sol"), 0);
    mod.recordChainSnapshot("base", hotTokens("base"), 0);
    await flush();
    expect(mod.getHottestChain("sol")).toBe("base");
  });

  it("getHottestChain falls back when no data", async () => {
    const mod = await import("../market-chain-intel.js");
    expect(mod.getHottestChain("sol")).toBe("sol");
  });

  it("getChainIntelligence returns null for unknown chain", async () => {
    const mod = await import("../market-chain-intel.js");
    expect(mod.getChainIntelligence("eth")).toBeNull();
  });

  it("isChainDead is true for missing chain and DEAD snapshots", async () => {
    const mod = await import("../market-chain-intel.js");
    expect(mod.isChainDead("eth")).toBe(true); // missing
    mod.recordChainSnapshot("bsc", [], 0); // DEAD
    await flush();
    expect(mod.isChainDead("bsc")).toBe(true);
    mod.recordChainSnapshot("sol", hotTokens("sol"), 0);
    await flush();
    expect(mod.isChainDead("sol")).toBe(false);
  });
});

describe("market-chain-intel — getChainAllocationWeights", () => {
  it("distributes proportionally and sums to ~1.0", async () => {
    const mod = await import("../market-chain-intel.js");
    mod.recordChainSnapshot("sol", hotTokens("sol"), 0);
    mod.recordChainSnapshot("base", coldTokens("base"), 0);
    await flush();
    const w = mod.getChainAllocationWeights(["sol", "base"]);
    const sum = w.sol + w.base;
    expect(sum).toBeGreaterThan(0.98);
    expect(sum).toBeLessThan(1.02);
    expect(w.sol).toBeGreaterThan(w.base); // hotter chain gets more
  });

  it("gives dead chains weight 0", async () => {
    const mod = await import("../market-chain-intel.js");
    mod.recordChainSnapshot("sol", hotTokens("sol"), 0);
    mod.recordChainSnapshot("bsc", [], 0); // DEAD
    await flush();
    const w = mod.getChainAllocationWeights(["sol", "bsc"]);
    expect(w.bsc).toBe(0);
    expect(w.sol).toBeCloseTo(1.0, 2);
  });

  it("falls back to even split when all chains are dead/no data", async () => {
    const mod = await import("../market-chain-intel.js");
    const w = mod.getChainAllocationWeights(["sol", "base", "bsc"]);
    expect(w.sol).toBeCloseTo(1 / 3, 2);
    expect(w.base).toBeCloseTo(1 / 3, 2);
    expect(w.bsc).toBeCloseTo(1 / 3, 2);
  });
});

describe("market-chain-intel — exports", () => {
  it("exports all expected functions", async () => {
    const mod = await import("../market-chain-intel.js");
    for (const fn of [
      "scoreChainActivity", "recordChainSnapshot", "getChainIntelligence",
      "getAllChainIntelligence", "rankChainsByActivity", "getHottestChain",
      "getChainAllocationWeights", "isChainDead",
    ]) {
      expect(typeof mod[fn]).toBe("function");
    }
  });
});
