/**
 * Paper wallet — virtual balance for demo testing.
 * Covers the env gating (incl. the hard live-mode guard) and the pure
 * balance-derivation math that feeds getWalletBalances() in demo.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { isPaperMode, getPaperStartSol, derivePaperBalance, capitalFractionFor, applyMarkToMarket, shouldForceExitStalePaper, withPositionIdentity } from "../paper-wallet.js";

const SAVED = {};
const KEYS = ["DRY_RUN", "EXECUTION_MODE", "PAPER_TRADING", "PAPER_START_SOL"];

beforeEach(() => { for (const k of KEYS) SAVED[k] = process.env[k]; });
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

function clearEnv() { for (const k of KEYS) delete process.env[k]; }

describe("isPaperMode gating", () => {
  it("is OFF in live even when PAPER_TRADING=true (hard guard)", () => {
    clearEnv();
    process.env.EXECUTION_MODE = "live";
    process.env.PAPER_TRADING = "true";
    process.env.PAPER_START_SOL = "10";
    expect(isPaperMode()).toBe(false);
  });

  it("is ON in demo with PAPER_TRADING=true", () => {
    clearEnv();
    process.env.EXECUTION_MODE = "demo";
    process.env.PAPER_TRADING = "true";
    expect(isPaperMode()).toBe(true);
  });

  it("respects DRY_RUN=true as the demo signal", () => {
    clearEnv();
    process.env.DRY_RUN = "true";
    process.env.PAPER_TRADING = "on";
    expect(isPaperMode()).toBe(true);
  });

  it("is OFF in demo when PAPER_TRADING=false even if a start balance is set", () => {
    clearEnv();
    process.env.EXECUTION_MODE = "demo";
    process.env.PAPER_TRADING = "false";
    process.env.PAPER_START_SOL = "10";
    expect(isPaperMode()).toBe(false);
  });

  it("defaults ON in demo with nothing configured (unified mode)", () => {
    clearEnv();
    process.env.EXECUTION_MODE = "demo";
    expect(isPaperMode()).toBe(true);
  });

  it("stays ON in demo when PAPER_START_SOL is configured", () => {
    clearEnv();
    process.env.EXECUTION_MODE = "demo";
    process.env.PAPER_START_SOL = "8";
    expect(isPaperMode()).toBe(true);
  });
});

describe("getPaperStartSol", () => {
  it("defaults to 5", () => { clearEnv(); expect(getPaperStartSol()).toBe(5); });
  it("reads PAPER_START_SOL", () => { clearEnv(); process.env.PAPER_START_SOL = "12.5"; expect(getPaperStartSol()).toBe(12.5); });
  it("falls back to 5 for invalid/≤0 values", () => {
    clearEnv(); process.env.PAPER_START_SOL = "-3"; expect(getPaperStartSol()).toBe(5);
    process.env.PAPER_START_SOL = "abc"; expect(getPaperStartSol()).toBe(5);
  });
});

describe("derivePaperBalance", () => {
  const SOL_PRICE = 150;

  it("returns full starting balance with no positions", () => {
    const b = derivePaperBalance({ solPrice: SOL_PRICE, positions: [], startSol: 5 });
    expect(b.sol).toBe(5);
    expect(b.sol_usd).toBe(750);
    expect(b.tokens).toEqual([]);
    expect(b.total_usd).toBe(750);
    expect(b.paper).toBe(true);
  });

  it("deducts open position cost-basis from SOL and lists the token", () => {
    const positions = [
      { position: "MintA", position_key: "MintA", amount_sol: 1, initial_value_usd: 150,
        signal_snapshot: { symbol: "AAA", entry_price: 0.0015, token_amount: 100000 } },
    ];
    const b = derivePaperBalance({ solPrice: SOL_PRICE, positions, startSol: 5 });
    expect(b.sol).toBe(4);                 // 5 − 1 deployed
    expect(b.tokens).toHaveLength(1);
    const t = b.tokens[0];
    expect(t.mint).toBe("MintA");
    expect(t.symbol).toBe("AAA");
    expect(t.balance).toBe(100000);        // uses recorded token_amount
    expect(t.usd).toBe(150);
    expect(b.total_usd).toBe(4 * SOL_PRICE + 150);
  });

  it("excludes closed positions and frees their SOL", () => {
    const positions = [
      { position: "Open", amount_sol: 1, initial_value_usd: 150, closed: false, signal_snapshot: { symbol: "O" } },
      { position: "Closed", amount_sol: 2, initial_value_usd: 300, closed: true, signal_snapshot: { symbol: "C" } },
    ];
    const b = derivePaperBalance({ solPrice: SOL_PRICE, positions, startSol: 5 });
    expect(b.sol).toBe(4);                 // only the open 1 SOL is deducted
    expect(b.tokens.map((t) => t.mint)).toEqual(["Open"]);
  });

  it("filters by wallet address when provided (null wallet positions always included)", () => {
    const positions = [
      { position: "W1", amount_sol: 1, initial_value_usd: 100, wallet_address: "walletA", signal_snapshot: {} },
      { position: "W2", amount_sol: 1, initial_value_usd: 100, wallet_address: "walletB", signal_snapshot: {} },
      { position: "W0", amount_sol: 1, initial_value_usd: 100, wallet_address: null, signal_snapshot: {} },
    ];
    const b = derivePaperBalance({ walletAddress: "walletA", solPrice: SOL_PRICE, positions, startSol: 5 });
    expect(b.tokens.map((t) => t.mint).sort()).toEqual(["W0", "W1"]);
  });

  it("derives token qty from cost basis / entry price when token_amount absent", () => {
    const positions = [
      { position: "M", amount_sol: 1, initial_value_usd: 200, signal_snapshot: { entry_price: 0.5 } },
    ];
    const b = derivePaperBalance({ solPrice: SOL_PRICE, positions, startSol: 5 });
    expect(b.tokens[0].balance).toBe(400); // 200 / 0.5
  });

  it("floors token usd at 0.1 so the dust filter never orphans a paper position", () => {
    const positions = [
      { position: "M", amount_sol: 0, initial_value_usd: 0, signal_snapshot: { symbol: "M" } },
    ];
    const b = derivePaperBalance({ solPrice: SOL_PRICE, positions, startSol: 5 });
    expect(b.tokens[0].usd).toBe(0.1);
  });

  it("never returns negative SOL when positions exceed starting capital", () => {
    const positions = [{ position: "M", amount_sol: 99, initial_value_usd: 100, signal_snapshot: {} }];
    const b = derivePaperBalance({ solPrice: SOL_PRICE, positions, startSol: 5 });
    expect(b.sol).toBe(0);
  });
});

describe("capitalFractionFor (multi-wallet split)", () => {
  const wallets = [
    { address: "walletA", capital_pct: 60 },
    { address: "walletB", capital_pct: 40 },
  ];

  it("returns 1 for aggregate calls (no wallet address)", () => {
    expect(capitalFractionFor(null, wallets)).toBe(1);
  });

  it("returns 1 for single-wallet setups", () => {
    expect(capitalFractionFor("walletA", [{ address: "walletA", capital_pct: 100 }])).toBe(1);
  });

  it("splits by capital_pct across multiple wallets (sums to 1)", () => {
    expect(capitalFractionFor("walletA", wallets)).toBeCloseTo(0.6, 6);
    expect(capitalFractionFor("walletB", wallets)).toBeCloseTo(0.4, 6);
    const total = capitalFractionFor("walletA", wallets) + capitalFractionFor("walletB", wallets);
    expect(total).toBeCloseTo(1, 6);
  });

  it("falls back to full balance for unknown address or invalid pct", () => {
    expect(capitalFractionFor("walletZ", wallets)).toBe(1);
    expect(capitalFractionFor("walletA", [{ address: "walletA", capital_pct: -5 }, { address: "x", capital_pct: 10 }])).toBe(1);
  });

  it("applied to startSol yields a correctly-split virtual balance", () => {
    // wallet A (60% of 5 SOL = 3) with 1 SOL deployed → 2 SOL free
    const b = derivePaperBalance({
      walletAddress: "walletA",
      solPrice: 150,
      positions: [{ position: "M", amount_sol: 1, initial_value_usd: 150, wallet_address: "walletA", signal_snapshot: {} }],
      startSol: getPaperStartSol() * capitalFractionFor("walletA", wallets), // 5 * 0.6 = 3
    });
    expect(b.sol).toBe(2);
  });
});

describe("applyMarkToMarket (exp #7: live re-pricing)", () => {
  const SOL_PRICE = 150;

  function openToken(overrides = {}) {
    const positions = [{
      position: "MintAAA", amount_sol: 1, initial_value_usd: 150, closed: false,
      signal_snapshot: { symbol: "AAA", entry_price: 0.002, token_amount: 75000 },
      ...overrides.position,
    }];
    const b = derivePaperBalance({ solPrice: SOL_PRICE, positions, startSol: 5 });
    return b.tokens[0];
  }

  it("derivePaperBalance exposes entry_price, cost_usd and chain on tokens", () => {
    const t = openToken();
    expect(t.entry_price).toBe(0.002);
    expect(t.cost_usd).toBe(150);
    expect(t.chain).toBe("sol");
  });

  it("re-prices usd by the live/entry ratio, not qty", () => {
    const t = openToken();
    applyMarkToMarket([t], { MintAAA: 0.001 }); // price halved
    expect(t.usd).toBe(75);
    expect(t.priceUsd).toBe(0.001);
    expect(t.price_unavailable).toBeUndefined();
  });

  it("a winner re-prices upward so TP gates can fire", () => {
    const t = openToken();
    applyMarkToMarket([t], { MintAAA: 0.003 }); // +50%
    expect(t.usd).toBe(225);
  });

  it("keeps the ≥0.1 floor for rugged-to-zero tokens (no dust orphan)", () => {
    const t = openToken();
    applyMarkToMarket([t], { MintAAA: 0.0000001 });
    expect(t.usd).toBe(0.1); // ~-99.9% PnL, still visible to management
  });

  it("flags price_unavailable on quote miss and keeps cost basis", () => {
    const t = openToken();
    applyMarkToMarket([t], {}); // no quote
    expect(t.price_unavailable).toBe(true);
    expect(t.usd).toBe(150);
  });

  it("sets priceUsd but keeps cost basis when entry price is missing", () => {
    const t = openToken({ position: { signal_snapshot: { symbol: "AAA" } } });
    applyMarkToMarket([t], { MintAAA: 0.005 });
    expect(t.priceUsd).toBe(0.005);
    expect(t.usd).toBe(150); // no entry → no ratio → cost basis stands
  });

  it("skips non-sol chain tokens (quotes are sol-only)", () => {
    const t = openToken({ position: { chain: "base" } });
    applyMarkToMarket([t], { MintAAA: 0.001 });
    expect(t.usd).toBe(150);
    expect(t.price_unavailable).toBeUndefined();
  });
});

describe("shouldForceExitStalePaper (exp #7: dead-token guard)", () => {
  const base = {
    tracked: { paper_trade: true },
    token: { price_unavailable: true },
    ageMinutes: 600,
    staleExitMinutes: 360,
  };

  it("fires for an old unquotable paper position", () => {
    expect(shouldForceExitStalePaper(base)).toBe(true);
  });

  it("never fires for live positions (paper_trade guard)", () => {
    expect(shouldForceExitStalePaper({ ...base, tracked: { paper_trade: false } })).toBe(false);
    expect(shouldForceExitStalePaper({ ...base, tracked: {} })).toBe(false);
  });

  it("does not fire while the token is still quotable", () => {
    expect(shouldForceExitStalePaper({ ...base, token: {} })).toBe(false);
  });

  it("respects the grace window", () => {
    expect(shouldForceExitStalePaper({ ...base, ageMinutes: 100 })).toBe(false);
    expect(shouldForceExitStalePaper({ ...base, ageMinutes: 361 })).toBe(true);
  });

  it("is safe on empty input", () => {
    expect(shouldForceExitStalePaper()).toBe(false);
    expect(shouldForceExitStalePaper({})).toBe(false);
  });
});

describe("withPositionIdentity", () => {
  it("preserves the token's own position_key and wallet_address (paper mode)", () => {
    // Regression: getPortfolioSnapshot used to rewrite position_key to
    // "mint::paper-wallet", which never matches state keyed by the real
    // pubkey — getTrackedPosition missed and every exit was silently skipped.
    const token = {
      mint: "MintA",
      position_key: "MintA::RealPubkey111",
      wallet_address: "RealPubkey111",
      usd: 2.5,
    };
    const out = withPositionIdentity(token, "paper-wallet");
    expect(out.position_key).toBe("MintA::RealPubkey111");
    expect(out.wallet_address).toBe("RealPubkey111");
    expect(out.usd).toBe(2.5);
  });

  it("derives mint::wallet for tokens without identity (real-wallet path)", () => {
    const out = withPositionIdentity({ mint: "MintB" }, "WalletX");
    expect(out.position_key).toBe("MintB::WalletX");
    expect(out.wallet_address).toBe("WalletX");
  });

  it("falls back to the bare mint when there is no wallet at all", () => {
    const out = withPositionIdentity({ mint: "MintC" }, null);
    expect(out.position_key).toBe("MintC");
    expect(out.wallet_address).toBe(null);
  });

  it("round-trips derivePaperBalance tokens with their tracked-state keys intact", () => {
    const positions = [
      { position: "MintD", position_key: "MintD::Pubkey222", wallet_address: "Pubkey222",
        amount_sol: 1, initial_value_usd: 150, signal_snapshot: { symbol: "DDD" } },
    ];
    const b = derivePaperBalance({ solPrice: 150, positions, startSol: 5 });
    const out = withPositionIdentity(b.tokens[0], b.wallet); // b.wallet = "paper-wallet"
    expect(b.wallet).toBe("paper-wallet");
    expect(out.position_key).toBe("MintD::Pubkey222");
    expect(out.wallet_address).toBe("Pubkey222");
  });
});
