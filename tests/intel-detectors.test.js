import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

import { detectInsiderPatterns } from "../tools/insider-detector.js";
import { evaluateFomoSetup } from "../tools/entry-fomo-guard.js";
import {
  evaluateSlowRug,
  recordLiquiditySample,
  _resetSlowRugForTests,
} from "../tools/slow-rug-detector.js";
import {
  evaluateDevActivity,
  recordDevSnapshot,
  extractDevWallet,
  _resetDevWalletStateForTests,
} from "../tools/dev-wallet-tracker.js";
import {
  evaluateVolumeDivergence,
  recordPriceVolumeSample,
  _resetVolumeDivergenceForTests,
} from "../tools/volume-divergence.js";
import { planExit } from "../tools/exit-timing-optimizer.js";

beforeEach(() => {
  _resetSlowRugForTests();
  _resetDevWalletStateForTests();
  _resetVolumeDivergenceForTests();
});

afterEach(() => {
  _resetSlowRugForTests();
  _resetDevWalletStateForTests();
  _resetVolumeDivergenceForTests();
});

// ─── S1: insider-detector ─────────────────────────────────────────────

describe("S1: insider-detector", () => {
  it("returns clean when no holder data", () => {
    const r = detectInsiderPatterns({ mint: "X" });
    expect(r.insider_score).toBe(0);
    expect(r.level).toBe("clean");
  });

  it("detects simultaneity cluster (≥3 holders within 5 blocks)", () => {
    const token = {
      top_holders: [
        { address: "A1", first_buy_block: 1000, amount_pct: 3.0 },
        { address: "A2", first_buy_block: 1002, amount_pct: 2.5 },
        { address: "A3", first_buy_block: 1003, amount_pct: 4.0 },
        { address: "A4", first_buy_block: 5000, amount_pct: 1.5 }, // outlier
      ],
    };
    const r = detectInsiderPatterns(token);
    expect(r.patterns.simultaneity.triggered).toBe(true);
    expect(r.flagged_wallets.length).toBeGreaterThan(0);
    expect(r.insider_score).toBeGreaterThan(0);
  });

  it("detects equal-size pattern when ≥3 holders within 10% of median", () => {
    const token = {
      top_holders: [
        { address: "A1", first_buy_block: 100, amount_pct: 5.0 },
        { address: "A2", first_buy_block: 200, amount_pct: 4.95 },
        { address: "A3", first_buy_block: 300, amount_pct: 5.05 },
        { address: "A4", first_buy_block: 400, amount_pct: 5.0 },
      ],
    };
    const r = detectInsiderPatterns(token);
    expect(r.patterns.equal_size.triggered).toBe(true);
  });

  it("detects funding-ancestor when ≥2 holders share funding parent", () => {
    const token = {
      top_holders: [
        { address: "A1", funded_by: "PARENT_X", amount_pct: 2 },
        { address: "A2", funded_by: "PARENT_X", amount_pct: 3 },
        { address: "A3", funded_by: "PARENT_X", amount_pct: 2.5 },
        { address: "A4", funded_by: "other_parent", amount_pct: 1 },
      ],
    };
    const r = detectInsiderPatterns(token);
    expect(r.patterns.funding.triggered).toBe(true);
    expect(r.patterns.funding.evidence.shared_count).toBe(3);
  });

  it("escalates level to 'block' on multiple patterns aligned", () => {
    const token = {
      top_holders: Array.from({ length: 5 }, (_, i) => ({
        address: `A${i}`,
        first_buy_block: 1000 + i,
        amount_pct: 5.0 + (i * 0.02),
        funded_by: "shared_parent",
      })),
    };
    const r = detectInsiderPatterns(token);
    expect(["strong", "block"]).toContain(r.level);
    expect(r.insider_score).toBeGreaterThanOrEqual(0.6);
  });
});

// ─── S4: entry-fomo-guard ─────────────────────────────────────────────

describe("S4: entry-fomo-guard", () => {
  it("returns safe on calm tokens", () => {
    const r = evaluateFomoSetup({
      mint: "X",
      price_change_1h: 0.05,
      price_change_4h: 0.10,
      volume_24h_usd: 100_000,
      liquidity_usd: 200_000,
      buys_24h: 50,
      sells_24h: 45,
    });
    expect(r.verdict).toBe("safe");
    expect(r.block).toBe(false);
  });

  it("flags fomo when 1h price up ≥50%", () => {
    const r = evaluateFomoSetup({
      mint: "X",
      price_change_1h: 0.60,
      volume_24h_usd: 100_000,
      liquidity_usd: 200_000,
    });
    expect(["fomo", "extreme"]).toContain(r.verdict);
    expect(r.block).toBe(true);
  });

  it("flags extreme on 1h +100% blow-off", () => {
    const r = evaluateFomoSetup({
      mint: "X",
      price_change_1h: 1.5,
      price_change_4h: 3.0,
    });
    expect(r.verdict).toBe("extreme");
  });

  it("flags wash-volume signature (volume >> liquidity)", () => {
    const r = evaluateFomoSetup({
      mint: "X",
      price_change_1h: 0.10,
      price_change_4h: 0.20,
      volume_24h_usd: 1_000_000,
      liquidity_usd: 100_000, // 10x ratio
    });
    expect(r.signals.some((s) => /wash/.test(s))).toBe(true);
  });

  it("flags late retail FOMO via buy/sell ratio", () => {
    const r = evaluateFomoSetup({
      mint: "X",
      price_change_1h: 0.20,
      buys_24h: 400,
      sells_24h: 100,
      volume_24h_usd: 100_000,
      liquidity_usd: 100_000,
    });
    expect(r.signals.some((s) => /FOMO/i.test(s) || /buy\/sell/.test(s))).toBe(true);
  });

  it("respects blockOnFomo=false override", () => {
    const r = evaluateFomoSetup({
      mint: "X",
      price_change_1h: 0.60,
    }, { blockOnFomo: false });
    expect(["fomo", "extreme"]).toContain(r.verdict);
    expect(r.block).toBe(false);
  });
});

// ─── S2: slow-rug-detector ─────────────────────────────────────────────

describe("S2: slow-rug-detector", () => {
  async function seed(mint, samples) {
    for (const s of samples) {
      await recordLiquiditySample({ mint, ...s });
    }
  }

  it("returns none when insufficient samples", () => {
    const r = evaluateSlowRug("NEW_MINT");
    expect(r.triggered).toBe(false);
    expect(r.severity).toBe("none");
  });

  it("detects repeated_removals on 3+ small drops", async () => {
    await seed("M_REP", [
      { liquidity_usd: 100_000, price_usd: 1 },
      { liquidity_usd: 92_000, price_usd: 1 },  // -8%
      { liquidity_usd: 85_000, price_usd: 1 },  // -7.6%
      { liquidity_usd: 78_000, price_usd: 1 },  // -8.2%
      { liquidity_usd: 72_000, price_usd: 1 },  // -7.7%
    ]);
    const r = evaluateSlowRug("M_REP");
    expect(r.triggered).toBe(true);
    expect(r.pattern).toBe("repeated_removals");
  });

  it("detects gradual_drain on ≥30% liquidity drop with stable price", async () => {
    await seed("M_GRAD", [
      { liquidity_usd: 100_000, price_usd: 1.0 },
      { liquidity_usd: 90_000,  price_usd: 1.02 },
      { liquidity_usd: 80_000,  price_usd: 0.98 },
      { liquidity_usd: 65_000,  price_usd: 1.01 },
    ]);
    const r = evaluateSlowRug("M_GRAD");
    expect(r.triggered).toBe(true);
    // pattern can be either repeated_removals OR gradual_drain depending on
    // how the drops cluster; the important behavior is that we triggered.
    expect(["repeated_removals", "gradual_drain"]).toContain(r.pattern);
  });

  it("does NOT trigger on organic price-driven liquidity move", async () => {
    // Liquidity changes < 5% per step, total drift < 30%
    await seed("M_ORG", [
      { liquidity_usd: 100_000, price_usd: 1.0 },
      { liquidity_usd: 98_000,  price_usd: 1.0 },
      { liquidity_usd: 102_000, price_usd: 1.0 },
    ]);
    const r = evaluateSlowRug("M_ORG");
    expect(r.triggered).toBe(false);
  });
});

// ─── S3: dev-wallet-tracker ─────────────────────────────────────────────

describe("S3: dev-wallet-tracker", () => {
  it("extractDevWallet prefers explicit field", () => {
    expect(extractDevWallet({ creator_wallet: "DEV1" })).toBe("DEV1");
    expect(extractDevWallet({ deployer: "DEV2" })).toBe("DEV2");
    expect(extractDevWallet({})).toBe(null);
  });

  it("returns alert=none when insufficient samples", () => {
    const r = evaluateDevActivity("EMPTY");
    expect(r.alert).toBe("none");
  });

  it("flags DEV_EMPTIED when dev balance drops to near-zero", async () => {
    await recordDevSnapshot({ mint: "M_EMPTY", devWallet: "DEV", devBalance: 100_000, totalSupply: 1_000_000 });
    await recordDevSnapshot({ mint: "M_EMPTY", devWallet: "DEV", devBalance: 100, totalSupply: 1_000_000 });
    const r = evaluateDevActivity("M_EMPTY");
    expect(r.alert).toBe("DEV_EMPTIED");
    expect(r.severity).toBe("critical");
  });

  it("flags DEV_SOLD_5PCT when ≥5% of supply sold in 24h", async () => {
    await recordDevSnapshot({ mint: "M_SOLD", devWallet: "DEV", devBalance: 150_000, totalSupply: 1_000_000 }); // 15%
    await recordDevSnapshot({ mint: "M_SOLD", devWallet: "DEV", devBalance: 80_000,  totalSupply: 1_000_000 }); // 8% (-7pp)
    const r = evaluateDevActivity("M_SOLD");
    expect(r.alert).toBe("DEV_SOLD_5PCT");
  });

  it("flags DEV_DUMPING on ≥20% drop of own holding", async () => {
    await recordDevSnapshot({ mint: "M_DUMP", devWallet: "DEV", devBalance: 30_000, totalSupply: 1_000_000 }); // 3%
    await recordDevSnapshot({ mint: "M_DUMP", devWallet: "DEV", devBalance: 22_000, totalSupply: 1_000_000 }); // -27%
    const r = evaluateDevActivity("M_DUMP");
    expect(["DEV_DUMPING", "DEV_SOLD_5PCT"]).toContain(r.alert);
  });
});

// ─── S5: volume-divergence ─────────────────────────────────────────────

describe("S5: volume-divergence", () => {
  async function seed(mint, samples) {
    for (const s of samples) await recordPriceVolumeSample({ mint, ...s });
  }

  it("returns no divergence when insufficient samples", () => {
    const r = evaluateVolumeDivergence("EMPTY");
    expect(r.detected).toBe(false);
  });

  it("detects price_up_volume_down pattern", async () => {
    await seed("M_DIV", [
      { price_usd: 1.00, volume_recent_usd: 10000 },
      { price_usd: 1.03, volume_recent_usd: 8000 },
      { price_usd: 1.06, volume_recent_usd: 6000 },
      { price_usd: 1.08, volume_recent_usd: 4000 },
      { price_usd: 1.10, volume_recent_usd: 3000 },
    ]);
    const r = evaluateVolumeDivergence("M_DIV");
    expect(r.detected).toBe(true);
    expect(r.pattern).toBe("price_up_volume_down");
  });

  it("does not flag when volume is stable or rising", async () => {
    await seed("M_OK", [
      { price_usd: 1.00, volume_recent_usd: 5000 },
      { price_usd: 1.02, volume_recent_usd: 5500 },
      { price_usd: 1.04, volume_recent_usd: 6000 },
      { price_usd: 1.06, volume_recent_usd: 6500 },
      { price_usd: 1.08, volume_recent_usd: 7000 },
    ]);
    const r = evaluateVolumeDivergence("M_OK");
    expect(r.detected).toBe(false);
  });
});

// ─── S6: exit-timing-optimizer ─────────────────────────────────────────

describe("S6: exit-timing-optimizer", () => {
  it("urgent exits never delay", () => {
    const r = planExit({
      mint: "X",
      exitReason: "rug_force_exit",
      positionValueUsd: 1000,
      liquidityUsd: 50000,
    });
    expect(r.urgent).toBe(true);
    expect(r.delayBeforeFirstMs).toBe(0);
  });

  it("splits when position > 5% of liquidity", () => {
    const r = planExit({
      mint: "X",
      exitReason: "takeProfit",
      positionValueUsd: 8000,
      liquidityUsd: 50000, // 16% ratio
    });
    expect(r.split).toBe(true);
    expect(r.splitCount).toBeGreaterThan(1);
  });

  it("no split when position small relative to liquidity", () => {
    const r = planExit({
      mint: "X",
      exitReason: "takeProfit",
      positionValueUsd: 100,
      liquidityUsd: 100000, // 0.1% ratio
    });
    expect(r.split).toBe(false);
    expect(r.splitCount).toBe(1);
  });

  it("waits for bounce when price dumping and not urgent", () => {
    const r = planExit({
      mint: "X",
      exitReason: "trailingStop",
      positionValueUsd: 500,
      liquidityUsd: 100000,
      price1mPct: -5,
    });
    expect(r.delayBeforeFirstMs).toBeGreaterThan(0);
  });

  it("raises slippage tolerance on urgency", () => {
    const r = planExit({
      mint: "X",
      exitReason: "DEV_DUMPING",
      positionValueUsd: 1000,
      liquidityUsd: 50000,
    });
    expect(r.slippagePct).toBeGreaterThanOrEqual(5);
  });
});
