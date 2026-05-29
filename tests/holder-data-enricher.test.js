import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the data sources so the enricher never touches the network in tests.
const getTokenSecurityDetails = vi.fn();
const getTokenKlines = vi.fn();
const fetchHeliusTxns = vi.fn();
const parseSolanaSwap = vi.fn();
const getHolderHistory = vi.fn(() => []);
const heliusCircuitOpen = vi.fn(() => false);
const fetchShyftHolders = vi.fn(async () => []);
const fetchShyftTokenSupply = vi.fn(async () => 0);

vi.mock("../tools/dexscreener.js", () => ({
  getTokenSecurityDetails: (...a) => getTokenSecurityDetails(...a),
  getTokenKlines: (...a) => getTokenKlines(...a),
  fetchHeliusTxns: (...a) => fetchHeliusTxns(...a),
  _internalSmartMoney: { parseSolanaSwap: (...a) => parseSolanaSwap(...a) },
}));
vi.mock("../tools/holder-dump-monitor.js", () => ({
  getHolderHistory: (...a) => getHolderHistory(...a),
}));
vi.mock("../tools/rug-signals.js", () => ({
  heliusCircuitOpen: (...a) => heliusCircuitOpen(...a),
  fetchShyftHolders: (...a) => fetchShyftHolders(...a),
  fetchShyftTokenSupply: (...a) => fetchShyftTokenSupply(...a),
}));
vi.mock("../logger.js", () => ({ log: () => {} }));
vi.mock("../metrics.js", () => ({ recordCounter: () => {} }));

const { enrichHolderData, _resetHolderEnricherCache } = await import("../tools/holder-data-enricher.js");

const MINT = "MintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"; // 36 chars
const ALL_ON = {
  dumpMonitor: { enabled: true, betaRolloutPct: 100 },
  entryPriceAnalysis: { enabled: true, betaRolloutPct: 100 },
  rugPatternDetector: { enabled: true, betaRolloutPct: 100 },
};

beforeEach(() => {
  _resetHolderEnricherCache();
  vi.clearAllMocks();
  getHolderHistory.mockReturnValue([]);
  heliusCircuitOpen.mockReturnValue(false);
  getTokenKlines.mockResolvedValue({ candles: [] });
  fetchShyftHolders.mockResolvedValue([]);
  fetchShyftTokenSupply.mockResolvedValue(0);
  // Default: no Shyft key → holder tests exercise the Helius fallback path.
  delete process.env.SHYFT_API_KEY;
});

describe("enrichHolderData — gating", () => {
  it("returns empty and does no fetch when all flags disabled", async () => {
    const r = await enrichHolderData({ mint: MINT, featureFlags: {} });
    expect(r.topHolders).toEqual([]);
    expect(getTokenSecurityDetails).not.toHaveBeenCalled();
  });

  it("returns empty for a mint outside the beta cohort", async () => {
    // betaRolloutPct=1 → almost every mint hashes out of cohort.
    const r = await enrichHolderData({ mint: MINT, featureFlags: { dumpMonitor: { enabled: true, betaRolloutPct: 1 } } });
    expect(r.topHolders).toEqual([]);
    expect(getTokenSecurityDetails).not.toHaveBeenCalled();
  });

  it("returns empty for an invalid/short mint", async () => {
    const r = await enrichHolderData({ mint: "short", featureFlags: ALL_ON });
    expect(r.topHolders).toEqual([]);
    expect(getTokenSecurityDetails).not.toHaveBeenCalled();
  });
});

describe("enrichHolderData — fetch + cache", () => {
  it("prefers Shyft (keyed by owner, pct from supply) when SHYFT_API_KEY is set", async () => {
    process.env.SHYFT_API_KEY = "real-shyft-key";
    fetchShyftHolders.mockResolvedValue([
      { owner: "w1", amount: 50 },
      { owner: "w2", amount: 25 },
    ]);
    fetchShyftTokenSupply.mockResolvedValue(1000);

    const r = await enrichHolderData({ mint: MINT, featureFlags: ALL_ON });
    expect(r.topHolders[0]).toEqual({ address: "w1", wallet: "w1", balance: 50, pct: 5 });
    expect(r.topHolders[1].pct).toBe(2.5);
    // Shyft satisfied the request → no Helius RPC fallback.
    expect(getTokenSecurityDetails).not.toHaveBeenCalled();
  });

  it("falls back to Helius when Shyft has no supply", async () => {
    process.env.SHYFT_API_KEY = "real-shyft-key";
    fetchShyftHolders.mockResolvedValue([{ owner: "w1", amount: 50 }]);
    fetchShyftTokenSupply.mockResolvedValue(0); // missing supply → fall through
    getTokenSecurityDetails.mockResolvedValue({
      holders: [{ address: "ta1", owner: "own1", token_amount: 1000, pct: 12.5 }],
    });

    const r = await enrichHolderData({ mint: MINT, featureFlags: ALL_ON });
    expect(getTokenSecurityDetails).toHaveBeenCalledTimes(1);
    // Helius path keys by owner so snapshots match the Shyft path.
    expect(r.topHolders[0]).toEqual({ address: "own1", wallet: "own1", balance: 1000, pct: 12.5 });
  });

  it("maps holders (pct + owner) and caches the result", async () => {
    getTokenSecurityDetails.mockResolvedValue({
      holders: [
        { address: "ta1", owner: "own1", token_amount: 1000, pct: 12.5 },
        { address: "ta2", owner: "own2", token_amount: 500, pct: 6.25 },
        { address: "", owner: null, token_amount: 1, pct: 0 }, // dropped (no address)
      ],
    });

    const r1 = await enrichHolderData({ mint: MINT, featureFlags: ALL_ON });
    expect(r1.topHolders).toHaveLength(2);
    // Helius fallback keys by owner (so snapshots match the Shyft path).
    expect(r1.topHolders[0]).toEqual({ address: "own1", wallet: "own1", balance: 1000, pct: 12.5 });
    expect(getTokenSecurityDetails).toHaveBeenCalledTimes(1);

    // Second call within TTL → served from cache, no second RPC.
    const r2 = await enrichHolderData({ mint: MINT, featureFlags: ALL_ON });
    expect(r2.fromCache).toBe(true);
    expect(getTokenSecurityDetails).toHaveBeenCalledTimes(1);
  });

  it("does NOT probe sells when no dump is suspected (quiet book)", async () => {
    getTokenSecurityDetails.mockResolvedValue({
      holders: [{ address: "ta1", owner: "own1", token_amount: 1000, pct: 12.5 }],
    });
    getHolderHistory.mockReturnValue([]); // no prior snapshot → not suspected

    const r = await enrichHolderData({ mint: MINT, featureFlags: ALL_ON });
    expect(r.recentSells).toEqual([]);
    expect(fetchHeliusTxns).not.toHaveBeenCalled();
  });

  it("probes sells only when a top holder's share dropped since last snapshot", async () => {
    getTokenSecurityDetails.mockResolvedValue({
      holders: [{ address: "ta1", owner: "own1", token_amount: 400, pct: 4 }],
    });
    // Previous snapshot had this holder (owner-keyed) at 10% → dropped 6 pts → suspected.
    getHolderHistory.mockReturnValue([{ holders: [{ address: "own1", pct: 10 }] }]);
    process.env.HELIUS_API_KEY = "real-key-not-dummy";
    fetchHeliusTxns.mockResolvedValue([{ timestamp: Date.now() / 1000, signature: "sig1" }]);
    parseSolanaSwap.mockReturnValue({ type: "sell", token_mint: MINT, sol_value: 2, token_amount: 100, signature: "sig1", timestamp: Date.now() / 1000 });

    const r = await enrichHolderData({ mint: MINT, featureFlags: ALL_ON });
    expect(fetchHeliusTxns).toHaveBeenCalled();
    expect(r.recentSells.length).toBeGreaterThan(0);
    expect(r.recentSells[0].address).toBe("own1");
  });
});
