/**
 * GMGN adapter coverage — the integration is dormant until GMGN_API_KEY is set,
 * so these tests are the only thing validating the response-shape normalizers
 * (which map *undocumented* GMGN fields) before the key ever goes live.
 *
 * Two layers:
 *   1. Pure / no-network: isGmgnEnabled gate, normalizeTopHolder field mapping,
 *      graceful null returns when disabled.
 *   2. fetch-stubbed: drives the real HTTP path so normalizeWallet /
 *      normalizeTrendingToken and the 429 circuit breaker are exercised.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  isGmgnEnabled,
  normalizeTopHolder,
  gmgnCircuitOpen,
  getTopHolders,
  getWalletActivity,
  getTrendingTokens,
  getSmartMoneyWallets,
  getWalletStats,
  getTokenSignals,
  getTrenches,
  extractGmgnRowRisk,
  _resetGmgnState,
} from "../tools/gmgn.js";

const REAL_KEY = process.env.GMGN_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (REAL_KEY === undefined) delete process.env.GMGN_API_KEY;
  else process.env.GMGN_API_KEY = REAL_KEY;
  _resetGmgnState();
});

describe("gmgn: enablement gate", () => {
  it("is disabled when key is absent", () => {
    delete process.env.GMGN_API_KEY;
    expect(isGmgnEnabled()).toBe(false);
  });

  it("is disabled for the dummy/placeholder key and too-short keys", () => {
    process.env.GMGN_API_KEY = "dummy-gmgn-key";
    expect(isGmgnEnabled()).toBe(false);
    process.env.GMGN_API_KEY = "short";
    expect(isGmgnEnabled()).toBe(false);
  });

  it("is enabled for a plausible real key", () => {
    process.env.GMGN_API_KEY = "gmgn_live_abcdef1234567890";
    expect(isGmgnEnabled()).toBe(true);
  });
});

describe("gmgn: graceful degradation when disabled", () => {
  beforeEach(() => { delete process.env.GMGN_API_KEY; });

  it("returns null/empty without ever touching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await getTopHolders("MintAbc")).toBeNull();
    expect(await getWalletActivity("Wallet1")).toBeNull();
    expect(await getTrendingTokens("1h")).toBeNull();
    expect(await getSmartMoneyWallets()).toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("gmgn: normalizeTopHolder", () => {
  it("maps primary GMGN field names + classification tags", () => {
    const out = normalizeTopHolder({
      wallet_address: "Holder111",
      amount: "12345",
      percent: "8.5",
      is_smart_money: true,
      is_bundler: true,
      is_sniper: false,
      is_rat: true,
      is_whale: false,
      is_kol: false,
    });
    expect(out.address).toBe("Holder111");
    expect(out.wallet).toBe("Holder111");
    expect(out.balance).toBe(12345);
    expect(out.pct).toBe(8.5);
    expect(out.tags).toEqual({
      smart_money: true, kol: false, rat: true,
      bundler: true, sniper: false, whale: false,
    });
  });

  it("falls back to alternate field names (address/balance/pct, bare tag keys)", () => {
    const out = normalizeTopHolder({
      address: "Holder222",
      balance: 7,
      pct: 3,
      bundler: true,
      sniper: true,
    });
    expect(out.wallet).toBe("Holder222");
    expect(out.balance).toBe(7);
    expect(out.pct).toBe(3);
    expect(out.tags.bundler).toBe(true);
    expect(out.tags.sniper).toBe(true);
    expect(out.tags.smart_money).toBe(false);
  });

  it("coerces missing numerics to 0 and tags to false", () => {
    const out = normalizeTopHolder({ wallet_address: "H" });
    expect(out.balance).toBe(0);
    expect(out.pct).toBe(0);
    expect(Object.values(out.tags).every((v) => v === false)).toBe(true);
  });

  it("maps the REAL GMGN shape: amount_percentage (0–1 → 0–100) + string tags", () => {
    const out = normalizeTopHolder({
      address: "Holder333",
      balance: 390566722.96,
      amount_percentage: 0.3905,                 // 0–1 fraction → 39.05%
      wallet_tag_v2: "TOP1",
      maker_token_tags: ["sniper", "bundler"],
      tags: ["smart_money"],
    });
    expect(out.address).toBe("Holder333");
    expect(out.pct).toBeCloseTo(39.05, 2);
    expect(out.tags.sniper).toBe(true);
    expect(out.tags.bundler).toBe(true);
    expect(out.tags.smart_money).toBe(true);
    expect(out.tags.whale).toBe(false);
  });

  it("does NOT rescale legacy percent/pct (already 0–100)", () => {
    expect(normalizeTopHolder({ address: "H", percent: "8.5" }).pct).toBe(8.5);
    expect(normalizeTopHolder({ address: "H", pct: 42 }).pct).toBe(42);
  });
});

describe("gmgn: HTTP path (fetch stubbed)", () => {
  beforeEach(() => {
    process.env.GMGN_API_KEY = "gmgn_live_abcdef1234567890";
    _resetGmgnState();
  });

  function okJson(data) {
    return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
  }

  it("aggregates the smart-money ACTIVITY FEED into distinct wallets (keyed by maker)", async () => {
    // Real GMGN /v1/user/smartmoney is a per-trade feed, not a wallet list.
    vi.stubGlobal("fetch", vi.fn(async () => okJson([
      { maker: "W1", side: "buy",  timestamp: 100, base_address: "MintA", maker_info: { name: "alpha", tags: ["smart_degen"] } },
      { maker: "W1", side: "sell", timestamp: 200, base_address: "MintB", maker_info: { name: "alpha", tags: ["smart_degen"] } },
      { maker: "W2", side: "buy",  timestamp: 150, base_address: "MintC", maker_info: { tags: ["kol"] } },
    ])));

    const wallets = await getSmartMoneyWallets(50);
    expect(wallets).toHaveLength(2);
    // W1 has 2 trades → ranked first; win rate/PnL are unknown from a feed.
    expect(wallets[0]).toMatchObject({
      address: "W1", label: "alpha", activityCount: 2, lastSide: "sell",
      lastToken: "MintB", winRate: null, realizedPnlUsd: null, tradeCount: null,
      source: "gmgn_smart_money",
    });
    expect(wallets[0].tags).toEqual(["smart_degen"]);
    expect(wallets[1]).toMatchObject({ address: "W2", activityCount: 1 });
  });

  it("normalizes wallet_stats: win_rate from pnl_stat.winrate (0–1), PnL as USD, trades=buy+sell", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson([
      {
        wallet_address: "W1",
        native_balance: 18.97,
        realized_profit: 4859.12,        // USD, not SOL
        realized_profit_pnl: 0.0865,
        buy: 524, sell: 519,
        pnl_stat: { winrate: 0.4645 },   // 0–1 fraction, nested
        common: { name: "whale", tags: ["smart_degen"] },
        last_timestamp: 1780170158,
      },
    ])));

    const stats = await getWalletStats("W1", "30d");
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      address: "W1",
      winRate: 0.4645,
      realizedPnlUsd: 4859.12,
      pnlRatio: 0.0865,
      tradeCount: 1043,
      nativeBalanceSol: 18.97,
      label: "whale",
      lastActive: 1780170158,
      source: "gmgn",
    });
  });

  it("normalizes a trending row (string numerics + GMGN field names)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({
      rank: [
        { address: "Tok1", symbol: "AAA", price: "0.5", marketcap: "120000", volume: "50000", swaps: "77", holder_count: "300", change1h: "12.5", smart_buy_24h: "4", launchpad: "pump.fun" },
      ],
    })));

    const trending = await getTrendingTokens("1h", 40);
    expect(trending).toHaveLength(1);
    expect(trending[0]).toMatchObject({
      address: "Tok1", symbol: "AAA", price: 0.5, marketcap: 120000,
      volume: 50000, swaps: 77, holder_count: 300, change1h: 12.5,
      smart_buy_count: 4, launchpad: "pump.fun",
    });
  });

  it("token_signal: sends group OBJECTS with valid signal_type (drops 14/15/16), not bare ints", async () => {
    let sentBody = null;
    vi.stubGlobal("fetch", vi.fn(async (_url, opts) => {
      sentBody = JSON.parse(opts.body);
      return okJson([{ token_address: "Sig1", signal_type: 1, market_cap: 50000, signal_times: 7 }]);
    }));

    const out = await getTokenSignals([1, 14, 15, 16, 7]);
    // Body must be { chain, groups:[{ signal_type:[…] }] } — the old [1,2,3] form 400s.
    expect(Array.isArray(sentBody.groups)).toBe(true);
    expect(sentBody.groups[0]).toHaveProperty("signal_type");
    expect(sentBody.groups[0].signal_type).toEqual([1, 7]); // 14/15/16 stripped
    expect(out).toEqual([{ token_address: "Sig1", signal_type: 1, market_cap: 50000, signal_times: 7 }]);
  });

  it("trenches: parses SERVER bucket keys (new_creation/completed/pump), tagging _trench_type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({
      version: "v2",
      new_creation: [{ address: "A", symbol: "AA" }],
      completed: [{ address: "B", symbol: "BB" }],
      pump: [{ address: "C", symbol: "CC" }],
    })));

    const out = await getTrenches(["new_creation", "near_completion", "completed"], 20);
    expect(out).toHaveLength(3);
    expect(out.find(t => t.address === "A")._trench_type).toBe("new_creation");
    expect(out.find(t => t.address === "B")._trench_type).toBe("completed");
    expect(out.find(t => t.address === "C")._trench_type).toBe("pump");
    // `version` is not a bucket and must be skipped.
    expect(out.some(t => t.address === undefined)).toBe(false);
  });

  it("trending: reads the REAL change% field names (price_change_percent1h/5m)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({
      rank: [{
        address: "Tok1", symbol: "AAA", price: "0.5", market_cap: "120000",
        price_change_percent1h: "12.5", price_change_percent5m: "3.2",
        smart_degen_count: "4", creation_timestamp: 1780000000,
      }],
    })));

    const trending = await getTrendingTokens("1h", 40);
    expect(trending[0]).toMatchObject({
      address: "Tok1", marketcap: 120000, change1h: 12.5, change5m: 3.2,
      smart_buy_count: 4, created_timestamp: 1780000000,
    });
  });

  it("trending: extracts GMGN pre-computed risk fields into _gmgn_risk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({
      rank: [{
        address: "RiskyTok", symbol: "RUG", price: "0.001",
        rug_ratio: "0.42", sniper_count: "55", bundler_rate: "0.30",
        top70_sniper_hold_rate: "0.18", rat_trader_amount_rate: "0.35",
        dev_team_hold_rate: "0.05", suspected_insider_hold_rate: "0.28",
        fresh_wallet_rate: "0.60",
      }],
    })));

    const trending = await getTrendingTokens("1h", 40);
    const risk = trending[0]._gmgn_risk;
    expect(risk).toBeDefined();
    expect(risk.rug_ratio).toBeCloseTo(0.42);
    expect(risk.sniper_count).toBe(55);
    expect(risk.bundler_rate).toBeCloseTo(0.30);
    expect(risk.rat_trader_amount_rate).toBeCloseTo(0.35);
    expect(risk.suspected_insider_hold_rate).toBeCloseTo(0.28);
    expect(risk.fresh_wallet_rate).toBeCloseTo(0.60);
  });

  it("extractGmgnRowRisk: absent fields are null, not 0", () => {
    const risk = extractGmgnRowRisk({ rug_ratio: "0.10" });
    expect(risk.rug_ratio).toBeCloseTo(0.10);
    expect(risk.sniper_count).toBeNull();
    expect(risk.bundler_rate).toBeNull();
  });

  it("opens the circuit on 429 and stops issuing further requests", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchSpy);

    expect(gmgnCircuitOpen()).toBe(false);
    const first = await getWalletActivity("WhaleX");
    expect(first).toBeNull();
    expect(gmgnCircuitOpen()).toBe(true);

    // Circuit is open → next call must short-circuit without a network hit.
    const callsAfter429 = fetchSpy.mock.calls.length;
    const second = await getTopHolders("MintY");
    expect(second).toBeNull();
    expect(fetchSpy.mock.calls.length).toBe(callsAfter429);
  });

  it("does not retry on 429 (single request, then circuit)", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchSpy);

    await getTrendingTokens("5m", 10);
    // exactly one network attempt — 429 must NOT be retried (it escalates bans).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
