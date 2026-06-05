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

const { enrichHolderData, _resetHolderEnricherCache, detectMultiWalletClusters } = await import("../tools/holder-data-enricher.js");

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

  it("attaches clusterAnalysis when holders are available", async () => {
    // 5 wallets each holding ~3% — should form a cluster
    getTokenSecurityDetails.mockResolvedValue({
      holders: [
        { address: "ta1", owner: "w1", token_amount: 300, pct: 3.0 },
        { address: "ta2", owner: "w2", token_amount: 310, pct: 3.1 },
        { address: "ta3", owner: "w3", token_amount: 295, pct: 2.95 },
        { address: "ta4", owner: "w4", token_amount: 305, pct: 3.05 },
        { address: "ta5", owner: "w5", token_amount: 290, pct: 2.9 },
      ],
    });

    const r = await enrichHolderData({ mint: MINT, featureFlags: ALL_ON });
    expect(r.clusterAnalysis).not.toBeNull();
    expect(r.clusterAnalysis.clusterRisk).not.toBe("CLEAN");
    expect(r.clusterAnalysis.clusters.length).toBeGreaterThan(0);
    expect(r.clusterAnalysis.largestClusterPct).toBeGreaterThanOrEqual(10);
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

describe("detectMultiWalletClusters", () => {
  const h = (address, pct) => ({ address, wallet: address, balance: pct * 100, pct });

  it("returns CLEAN and no clusters for a natural distribution", () => {
    const holders = [h("w1", 15), h("w2", 8), h("w3", 5), h("w4", 3), h("w5", 1.5)];
    const r = detectMultiWalletClusters(holders);
    expect(r.clusterRisk).toBe("CLEAN");
    expect(r.clusters).toHaveLength(0);
  });

  it("detects SUSPICIOUS cluster when 3+ wallets share similar pct", () => {
    // 3 wallets at ~5% → combined 15% → SUSPICIOUS
    const holders = [h("w1", 5.1), h("w2", 5.0), h("w3", 4.9), h("w4", 20), h("w5", 2)];
    const r = detectMultiWalletClusters(holders);
    expect(r.clusters.length).toBeGreaterThan(0);
    expect(r.largestClusterPct).toBeCloseTo(15, 0);
    expect(r.clusterRisk).toBe("SUSPICIOUS");
    expect(r.clusters[0].walletCount).toBe(3);
    expect(r.clusters[0].signal).toBe("uniform_split");
  });

  it("detects HIGH cluster when combined pct >= 25%", () => {
    // 5 wallets at ~5% → combined 25%
    const holders = [h("a", 5.0), h("b", 5.1), h("c", 4.8), h("d", 5.2), h("e", 5.0), h("f", 1)];
    const r = detectMultiWalletClusters(holders);
    expect(r.clusterRisk).toBe("HIGH");
    expect(r.largestClusterPct).toBeGreaterThanOrEqual(25);
    expect(r.same_funder_holders).toBe(r.clusters[0].walletCount);
  });

  it("detects CRITICAL cluster when combined pct >= 40%", () => {
    // 8 wallets each at 5% → combined 40%
    const holders = Array.from({ length: 8 }, (_, i) => h(`w${i}`, 5.0));
    const r = detectMultiWalletClusters(holders);
    expect(r.clusterRisk).toBe("CRITICAL");
    expect(r.largestClusterPct).toBeGreaterThanOrEqual(40);
  });

  it("does not flag when only 2 wallets match (below MIN_CLUSTER_SIZE=3)", () => {
    const holders = [h("a", 5.0), h("b", 5.1), h("c", 2), h("d", 3), h("e", 1)];
    const r = detectMultiWalletClusters(holders);
    // Only a+b match, which is 2 wallets < MIN_CLUSTER_SIZE
    expect(r.clusterRisk).toBe("CLEAN");
  });

  it("returns CLEAN and no cluster when fewer than 3 holders total", () => {
    const holders = [h("a", 30), h("b", 20)];
    const r = detectMultiWalletClusters(holders);
    expect(r.clusterRisk).toBe("CLEAN");
    expect(r.clusters).toHaveLength(0);
  });

  it("correctly reports same_funder_holders as largest cluster size", () => {
    const holders = [h("w1", 3.0), h("w2", 3.1), h("w3", 2.9), h("w4", 3.05), h("w5", 10)];
    const r = detectMultiWalletClusters(holders);
    expect(r.same_funder_holders).toBe(r.clusters[0]?.walletCount ?? 0);
  });
});
