import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// GAP 4 coverage: huntDexScreenerSearch fires a rotating window of
// SEARCH_WINDOW (4) DexScreener queries per expedition via Promise.allSettled.
// A single query failure (network error / rate-limit) must NOT sink the whole
// search eye — tokens from the surviving queries must still be returned.
// huntDexScreenerSearch is not exported, so we drive it through the public
// runHunterExpedition() entry point and mock global.fetch.

const SOL_MINT = "So11111111111111111111111111111111111111112";

// A DexScreener pair that passes the search eye's gates:
//   liquidity >= 500, swaps >= 5, mcap >= 5000, age between 5min and 168h.
function makePair(addr, symbol) {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: `pair-${addr}`,
    baseToken: { address: addr, symbol, name: symbol },
    priceUsd: "0.001",
    marketCap: 50_000,
    fdv: 50_000,
    liquidity: { usd: 20_000 },
    volume: { h24: 30_000 },
    txns: { h24: { buys: 40, sells: 40 } },
    priceChange: { m5: 1, h1: 5, h24: 10 },
    // 1 hour old — inside the [5min, 168h] window
    pairCreatedAt: Date.now() - 60 * 60 * 1000,
  };
}

let savedFetch;

beforeEach(() => {
  vi.resetModules();
  savedFetch = global.fetch;
});

afterEach(() => {
  global.fetch = savedFetch;
  vi.restoreAllMocks();
});

describe("hunter — DexScreener search window graceful degradation (GAP 4)", () => {
  it("returns tokens from surviving queries when one search query fails", async () => {
    // The search eye walks HUNT_QUERIES; the first window starts at "ai".
    // We make exactly one query throw (simulating a network failure) and a
    // different query succeed, then assert the good token survives.
    let goodSeen = false;
    let failInjected = false;

    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      // Only intercept DexScreener search calls.
      if (u.includes("/latest/dex/search?q=")) {
        const q = decodeURIComponent(u.split("q=")[1] || "");
        // Inject a single hard failure on the first query of the window.
        if (q === "ai" && !failInjected) {
          failInjected = true;
          throw new Error("simulated network failure");
        }
        // One query returns a valid Solana pair the eye will keep.
        if (q === "agent") {
          goodSeen = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ pairs: [makePair("GoodTokenMintAddr", "GOOD")] }),
          };
        }
      }
      // Everything else (other eyes, other queries) returns empty pairs.
      return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
    });

    const { runHunterExpedition } = await import("../tools/hunter-agent.js");
    const tokens = await runHunterExpedition({ strategy: { narratives: [] } });

    expect(failInjected).toBe(true); // a query really did fail
    expect(goodSeen).toBe(true); // a sibling query really did run
    expect(Array.isArray(tokens)).toBe(true);
    const good = tokens.find(t => t.mint === "GoodTokenMintAddr");
    expect(good).toBeDefined();
    expect(good.symbol).toBe("GOOD");
    // SOL itself must never be returned as a candidate.
    expect(tokens.some(t => t.mint === SOL_MINT)).toBe(false);
  });

  it("returns an empty (not throwing) result when every search query fails", async () => {
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/latest/dex/search?q=")) {
        throw new Error("all queries down");
      }
      return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
    });

    const { runHunterExpedition } = await import("../tools/hunter-agent.js");
    const tokens = await runHunterExpedition({ strategy: { narratives: [] } });
    // Graceful: expedition completes and returns an array even when the
    // search eye is fully down.
    expect(Array.isArray(tokens)).toBe(true);
  });
});
