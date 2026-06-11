import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Narrative-heat-driven hunting (experiment #9):
//   1. getHotNarratives() prioritizes velocity-sustained > heat-hot >
//      velocity-emerging and excludes heat-cold narratives.
//   2. huntDexScreenerSearch appends up to HOT_QUERY_EXTRA heat queries ON TOP
//      of the rotation window — exploration coverage is never reduced.
//   3. runHunterExpedition auto-fills strategy.narratives from hot narratives
//      so the narrative_match scoring bonus actually fires.
//   4. The caller's strategy object is never mutated.

// Mock only the heat/velocity readers — taxonomy + classifyNarrative stay real.
vi.mock("../tools/narratives.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getNarrativeHeat: vi.fn(() => ({ ranked: [], hot: [], cold: [], emerging: [] })),
    getCrossBatchVelocity: vi.fn(() => ({ active: [], sustained: [], emerging: [] })),
  };
});

function makePair(addr, symbol, name = symbol) {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: `pair-${addr}`,
    baseToken: { address: addr, symbol, name },
    priceUsd: "0.001",
    marketCap: 50_000,
    fdv: 50_000,
    liquidity: { usd: 20_000 },
    volume: { h24: 30_000 },
    txns: { h24: { buys: 40, sells: 40 } },
    priceChange: { m5: 1, h1: 5, h24: 10 },
    pairCreatedAt: Date.now() - 60 * 60 * 1000,
  };
}

let savedFetch;

beforeEach(async () => {
  vi.resetModules();
  savedFetch = global.fetch;
  // mockReturnValue persists across tests (module-level vi.fn) — re-pin the
  // empty defaults so each test starts from a clean heat/velocity state.
  const narratives = await import("../tools/narratives.js");
  narratives.getNarrativeHeat.mockReturnValue({ ranked: [], hot: [], cold: [], emerging: [] });
  narratives.getCrossBatchVelocity.mockReturnValue({ active: [], sustained: [], emerging: [] });
});

afterEach(() => {
  global.fetch = savedFetch;
  vi.restoreAllMocks();
});

describe("getHotNarratives — priority and cold exclusion", () => {
  it("orders sustained > hot > emerging, dedupes, and drops heat-cold narratives", async () => {
    const narratives = await import("../tools/narratives.js");
    narratives.getCrossBatchVelocity.mockReturnValue({
      sustained: ["DOGS", "CATS"],
      emerging: ["GAMING", "FOOD"],
      active: [],
    });
    narratives.getNarrativeHeat.mockReturnValue({
      ranked: [], hot: ["AI", "DOGS"], cold: ["CATS"], emerging: [],
    });

    const { getHotNarratives } = await import("../tools/hunter-agent.js");
    const hot = getHotNarratives();

    // CATS is velocity-sustained but heat-cold → excluded. Cap = 3 narratives.
    expect(hot.narratives).toEqual(["DOGS", "AI", "GAMING"]);
    // Queries come from taxonomy keywords (first 2 per narrative), deduped.
    expect(hot.queries).toContain("dog");
    expect(hot.queries).toContain("ai");
    expect(hot.queries).not.toContain("cat");
  });

  it("returns empty lists when heat/velocity have no data", async () => {
    const { getHotNarratives } = await import("../tools/hunter-agent.js");
    const hot = getHotNarratives();
    expect(hot.narratives).toEqual([]);
    expect(hot.queries).toEqual([]);
  });

  it("ignores names that are not in the taxonomy", async () => {
    const narratives = await import("../tools/narratives.js");
    narratives.getCrossBatchVelocity.mockReturnValue({
      sustained: ["NOT_A_NARRATIVE"], emerging: [], active: [],
    });
    const { getHotNarratives } = await import("../tools/hunter-agent.js");
    expect(getHotNarratives().narratives).toEqual([]);
  });
});

describe("huntDexScreenerSearch — heat queries are additive", () => {
  it("fires the full rotation window PLUS hot-narrative queries", async () => {
    const narratives = await import("../tools/narratives.js");
    narratives.getCrossBatchVelocity.mockReturnValue({
      sustained: ["DOGS"], emerging: [], active: [],
    });

    const searchQueries = [];
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/latest/dex/search?q=")) {
        searchQueries.push(decodeURIComponent(u.split("q=")[1] || ""));
      }
      return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
    });

    const { runHunterExpedition } = await import("../tools/hunter-agent.js");
    await runHunterExpedition({ strategy: { narratives: ["DOGS"] } });

    // Rotation window intact: first window starts at "ai", "agent", ...
    expect(searchQueries).toContain("ai");
    expect(searchQueries).toContain("agent");
    // Hot extras appended: DOGS taxonomy keywords ("dog", "doge").
    expect(searchQueries).toContain("dog");
  });
});

describe("runHunterExpedition — strategy.narratives auto-fill + scoring bonus", () => {
  it("auto-fills narratives from hot list and awards narrative_match via word-boundary", async () => {
    const narratives = await import("../tools/narratives.js");
    narratives.getCrossBatchVelocity.mockReturnValue({
      sustained: ["DOGS"], emerging: [], active: [],
    });

    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/latest/dex/search?q=")) {
        const q = decodeURIComponent(u.split("q=")[1] || "");
        if (q === "ai") {
          return {
            ok: true, status: 200,
            json: async () => ({
              pairs: [
                // Matches DOGS via word boundary ("dog" in name)
                makePair("DogTokenMintAddr", "MOONDOG", "Moon Dog"),
                // "Chains" contains "ai"? no — control token matching nothing;
                // also guards against substring over-match on short keywords.
                makePair("PlainTokenMintAddr", "BRICK", "Brick House"),
              ],
            }),
          };
        }
      }
      return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
    });

    const { runHunterExpedition } = await import("../tools/hunter-agent.js");
    // No narratives in strategy → should be auto-filled from hot list.
    const callerStrategy = { minScore: 0 };
    const tokens = await runHunterExpedition({ strategy: callerStrategy });

    const dog = tokens.find(t => t.mint === "DogTokenMintAddr");
    const plain = tokens.find(t => t.mint === "PlainTokenMintAddr");
    expect(dog).toBeDefined();
    expect(plain).toBeDefined();
    expect(dog._hunter_reasons).toContain("narrative_match");
    expect(plain._hunter_reasons).not.toContain("narrative_match");

    // Caller's strategy object must not be mutated by the auto-fill.
    expect(callerStrategy.narratives).toBeUndefined();
  });
});
