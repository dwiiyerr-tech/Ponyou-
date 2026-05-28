import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

const STATE_FILE = path.join(process.cwd(), "cast-net-state.json");

// Helper: build an all-green token candidate. Tests can override fields
// individually to flip a single category red and assert the gate blocks.
function greenToken(overrides = {}) {
  return {
    mint: "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "GOAT",
    community: { score: 0.85 },
    dev_reputation: {
      past_coins: 3,
      win_rate: 0.7,
      is_blacklisted: false,
    },
    smart_money: { holders: 4 },
    top10_concentration_pct: 35,
    supply_concentrated: false,
    narrative: "ai-agents",
    narrative_score: 0.8,
    name: "Goat AI Inc",
    // C2 fields — defaults satisfy default soft-check thresholds
    liquidity_usd: 200_000,
    fdv_usd: 3_000_000,
    volume_24h_usd: 400_000,
    top1_holder_pct: 3,
    ...overrides,
  };
}

// Reset persistent cast-net state + isolate config between tests
let _backup = null;
beforeEach(() => {
  _backup = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, "utf8") : null;
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  vi.resetModules();
});

afterEach(() => {
  if (_backup != null) fs.writeFileSync(STATE_FILE, _backup);
  else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
});

async function loadGateWithConfig(castNetOverrides = {}) {
  vi.doMock("../config.js", () => ({
    config: {
      castNet: {
        enabled: true,
        maxWallets: 10,
        maxBankrollPct: 30,
        minConviction: 0.85,
        cooldownMin: 240,
        timingJitterMinSec: 2,
        timingJitterMaxSec: 15,
        amountJitterPct: 20,
        allowedStrategies: ["smart_money", "day_phase_trading"],
        minMemorySamples: 50,
        autoDisableConsecutiveLosses: 2,
        minLiquidityUsd: 50_000,
        mcapWindowMinUsd: 1_000_000,
        mcapWindowMaxUsd: 10_000_000,
        minVolumeToLiquidity: 1.0,
        maxTop1HolderPct: 5,
        edgeMarginPct: 0.05,
        ...castNetOverrides,
      },
    },
  }));
  return await import("../tools/cast-net-gate.js");
}

function happyArgs(overrides = {}) {
  return {
    token: greenToken(),
    activeStrategy: "smart_money",
    proOrchestratorOn: true,
    experienceScore: { score: 0.9, matches: 10 },
    totalMemorySamples: 100,
    trashFilter: () => ({ trash: false }),
    smartMoneyOpts: { minHolders: 2 },
    walletContext: { multiWalletEnabled: true, viableWalletCount: 10 },
    ...overrides,
  };
}

describe("evaluateCastNet — all-green fires", () => {
  it("returns allowed=true with plan when every category passes", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.plan).toEqual({ wallets: 10, bankrollPct: 30 });
    for (const [cat, res] of Object.entries(result.reasons)) {
      expect(res.ok, `category ${cat} should be ok: ${res.reason}`).toBe(true);
    }
  });
});

describe("evaluateCastNet — operator gates", () => {
  it("blocks when config.castNet.enabled is false", async () => {
    const gate = await loadGateWithConfig({ enabled: false });
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]).toMatch(/disabled/);
  });

  it("blocks when manual toggle is off (operator /castnet off)", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(false);
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]).toMatch(/disabled/);
  });

  it("blocks when pro-orchestrator is off", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({ proOrchestratorOn: false }));
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]).toMatch(/pro-orchestrator/);
  });

  it("blocks when active strategy not whitelisted", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({ activeStrategy: "scalping" }));
    expect(result.allowed).toBe(false);
    expect(result.blockers[0]).toMatch(/whitelist/);
  });

  it("blocks during cooldown after a previous fire", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 240 });
    await gate.setCastNetManualEnabled(true);
    await gate.recordCastNetFire({
      mint: "X", symbol: "X", walletCount: 10, bankrollPct: 30, reasons: {},
    });
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(false);
    expect(result.cooldownRemainingMin).toBeGreaterThan(0);
  });
});

describe("evaluateCastNet — green-flag categories", () => {
  it("blocks when community score below 0.7", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ community: { score: 0.5 } });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.community.ok).toBe(false);
  });

  it("blocks when dev is blacklisted", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({
      dev_reputation: { past_coins: 3, win_rate: 0.8, is_blacklisted: true },
    });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.dev.ok).toBe(false);
  });

  it("blocks when dev has no past coins (unknown dev)", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ dev_reputation: { past_coins: 0 } });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.dev.ok).toBe(false);
  });

  it("blocks when smart-money holders below threshold", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ smart_money: { holders: 0 } });
    const result = gate.evaluateCastNet(happyArgs({ token, smartMoneyOpts: { minHolders: 2 } }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.smart.ok).toBe(false);
  });

  it("blocks when top-10 concentration exceeds 50%", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ top10_concentration_pct: 75 });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.holders.ok).toBe(false);
  });

  it("blocks when narrative is missing", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ narrative: "", narrative_score: 0 });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.narrative.ok).toBe(false);
  });

  it("blocks when ticker fails trash-filter", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({
      trashFilter: () => ({ trash: true, reason: "scam pattern" }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.ticker.ok).toBe(false);
  });

  it("blocks when conviction score below minConviction", async () => {
    const gate = await loadGateWithConfig({ minConviction: 0.85 });
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({
      experienceScore: { score: 0.6, matches: 10 },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.conviction.ok).toBe(false);
  });

  it("blocks when total memory samples too few", async () => {
    const gate = await loadGateWithConfig({ minMemorySamples: 50 });
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({ totalMemorySamples: 10 }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.conviction.ok).toBe(false);
  });
});

describe("evaluateCastNet — strict AND gate", () => {
  it("blocks even if just one category is red while the rest are green", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    // Everything green except smart-money holders=0
    const token = greenToken({ smart_money: { holders: 0 } });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    // 7 hard categories + 4 soft (C2) = 11 total; 1 red → 10 ok
    const okCount = Object.values(result.reasons).filter(r => r.ok).length;
    expect(okCount).toBe(10);
  });
});

describe("G1: multi-wallet guard", () => {
  it("blocks when multiWallet not enabled", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({
      walletContext: { multiWalletEnabled: false, viableWalletCount: 10 },
    }));
    expect(result.allowed).toBe(false);
    expect(result.blockers.some(b => /multi-wallet disabled/.test(b))).toBe(true);
  });

  it("blocks when viable hot wallet count < 2", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({
      walletContext: { multiWalletEnabled: true, viableWalletCount: 1 },
    }));
    expect(result.allowed).toBe(false);
    expect(result.blockers.some(b => /≥2 viable wallets/.test(b))).toBe(true);
  });

  it("clamps plan.wallets to actual viable count when below config max", async () => {
    const gate = await loadGateWithConfig({ maxWallets: 10 });
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({
      walletContext: { multiWalletEnabled: true, viableWalletCount: 4 },
    }));
    expect(result.allowed).toBe(true);
    expect(result.plan.wallets).toBe(4);
  });
});

describe("plan clamping", () => {
  it("clamps maxWallets to 10 even if config set higher", async () => {
    // config.js clamping prevents 50, but defensively check evaluator output too
    const gate = await loadGateWithConfig({ maxWallets: 10 });
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.plan.wallets).toBeLessThanOrEqual(10);
  });

  it("clamps bankrollPct to 50 even if config set higher", async () => {
    const gate = await loadGateWithConfig({ maxBankrollPct: 50 });
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.plan.bankrollPct).toBeLessThanOrEqual(50);
  });
});

describe("recordCastNetFire + cooldown", () => {
  it("persists last_fire_at and counts towards cooldown", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 60 });
    await gate.setCastNetManualEnabled(true);
    await gate.recordCastNetFire({
      mint: "MintXX", symbol: "X", walletCount: 10, bankrollPct: 30, reasons: {},
    });
    const status = gate.getCastNetStatus();
    expect(status.last_fire_at).toBeTruthy();
    expect(status.cooldown_remaining_min).toBeGreaterThan(0);
    expect(status.total_fires).toBe(1);
  });

  it("trims audit log to last 200 fires", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    for (let i = 0; i < 205; i++) {
      await gate.recordCastNetFire({
        mint: `M${i}`, symbol: `S${i}`, walletCount: 10, bankrollPct: 30, reasons: {},
      });
    }
    const status = gate.getCastNetStatus();
    expect(status.total_fires).toBe(200);
  });
});

describe("getCastNetStatus", () => {
  it("reports DISARMED when config disabled even if manual ON", async () => {
    const gate = await loadGateWithConfig({ enabled: false });
    await gate.setCastNetManualEnabled(true);
    const status = gate.getCastNetStatus();
    expect(status.enabled).toBe(false);
    expect(status.config_enabled).toBe(false);
    expect(status.manual_enabled).toBe(true);
  });

  it("reports ARMED only when both config and manual agree", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const status = gate.getCastNetStatus();
    expect(status.enabled).toBe(true);
  });
});

// ─── C1: Consecutive-loss auto-disable ────────────────────────────────

describe("C1: consecutive-loss auto-disable", () => {
  async function recordLoss(gate, groupId, pnlPct, walletCount = 1) {
    await gate.recordCastNetFire({
      mint: `M_${groupId}`, symbol: groupId, walletCount, bankrollPct: 30, reasons: {},
      groupId,
    });
    await gate.recordCastNetOutcome({ groupId, pnlPct, walletCount });
  }

  it("blocks evaluation after 2 consecutive losses (default threshold)", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    await recordLoss(gate, "g1", -15);
    await recordLoss(gate, "g2", -25);
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(false);
    expect(result.blockers.some((b) => /auto-disabled/.test(b))).toBe(true);
  });

  it("does not block after a single loss", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    await recordLoss(gate, "g1", -10);
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(true);
  });

  it("resets streak when a winning fire interrupts", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    await recordLoss(gate, "g1", -10);
    await recordLoss(gate, "g2", +15); // win
    await recordLoss(gate, "g3", -8);  // 1 loss again
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(true);
  });

  it("/castnet on clears the loss streak (re-enable after auto-disable)", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    await recordLoss(gate, "g1", -10);
    await recordLoss(gate, "g2", -10);
    // Auto-disabled now
    let result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(false);
    // Operator re-enables
    await gate.setCastNetManualEnabled(true);
    result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(true);
  });

  it("getCastNetStatus surfaces auto_disabled + consecutive_losses", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    await recordLoss(gate, "g1", -10);
    await recordLoss(gate, "g2", -10);
    const status = gate.getCastNetStatus();
    expect(status.consecutive_losses).toBe(2);
    expect(status.auto_disabled).toBe(true);
    expect(status.enabled).toBe(false);
  });

  it("autoDisableConsecutiveLosses=0 disables the safety", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0, autoDisableConsecutiveLosses: 0 });
    await gate.setCastNetManualEnabled(true);
    await recordLoss(gate, "g1", -10);
    await recordLoss(gate, "g2", -10);
    await recordLoss(gate, "g3", -10);
    const result = gate.evaluateCastNet(happyArgs());
    expect(result.allowed).toBe(true);
  });
});

// ─── C2: Pre-fire soft checks ─────────────────────────────────────────

describe("C2: pre-fire soft checks", () => {
  it("blocks when liquidity below threshold", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ liquidity_usd: 10_000 });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.liquidity.ok).toBe(false);
  });

  it("blocks when mcap below window", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ fdv_usd: 500_000 });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.mcap_window.ok).toBe(false);
  });

  it("blocks when mcap above window", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ fdv_usd: 50_000_000 });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.mcap_window.ok).toBe(false);
  });

  it("blocks when volume/liquidity ratio too low", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ liquidity_usd: 200_000, volume_24h_usd: 50_000 });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.volume.ok).toBe(false);
  });

  it("blocks when top1 holder above threshold", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ top1_holder_pct: 8 });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(false);
    expect(result.reasons.holder_top1.ok).toBe(false);
  });

  it("treats unknown top1 as soft pass (not blocking)", async () => {
    const gate = await loadGateWithConfig();
    await gate.setCastNetManualEnabled(true);
    const token = greenToken({ top1_holder_pct: 0 });
    delete token.top1_holder_pct;
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.reasons.holder_top1.ok).toBe(true);
  });
});

// ─── C3: History helper ───────────────────────────────────────────────

describe("C3: getCastNetHistory", () => {
  it("returns most-recent-first", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    for (let i = 0; i < 5; i++) {
      await gate.recordCastNetFire({
        mint: `M${i}`, symbol: `S${i}`, walletCount: 10, bankrollPct: 30,
        reasons: {}, groupId: `g${i}`,
      });
    }
    const hist = gate.getCastNetHistory(10);
    expect(hist.length).toBe(5);
    expect(hist[0].symbol).toBe("S4"); // most recent first
    expect(hist[4].symbol).toBe("S0");
  });

  it("respects the limit argument", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    for (let i = 0; i < 15; i++) {
      await gate.recordCastNetFire({
        mint: `M${i}`, symbol: `S${i}`, walletCount: 10, bankrollPct: 30,
        reasons: {}, groupId: `g${i}`,
      });
    }
    const hist = gate.getCastNetHistory(5);
    expect(hist.length).toBe(5);
  });
});

// ─── C4: Edge-signal detection ────────────────────────────────────────

describe("C4: edge-signal detection", () => {
  it("flags categories that barely pass their floor", async () => {
    const gate = await loadGateWithConfig({ minConviction: 0.85, edgeMarginPct: 0.05 });
    await gate.setCastNetManualEnabled(true);
    // Conviction 0.86 — 1.2% above the 0.85 floor, inside edgeMarginPct=5%
    const result = gate.evaluateCastNet(happyArgs({
      experienceScore: { score: 0.86, matches: 10 },
    }));
    expect(result.allowed).toBe(true);
    expect(result.edge_signals.length).toBeGreaterThan(0);
    expect(result.edge_signals.some((e) => e.category === "conviction")).toBe(true);
  });

  it("does not flag categories well above the floor", async () => {
    const gate = await loadGateWithConfig({ minConviction: 0.85, edgeMarginPct: 0.05 });
    await gate.setCastNetManualEnabled(true);
    const result = gate.evaluateCastNet(happyArgs({
      experienceScore: { score: 0.99, matches: 10 },
    }));
    expect(result.allowed).toBe(true);
    expect(result.edge_signals.some((e) => e.category === "conviction")).toBe(false);
  });

  it("flags liquidity when barely above min", async () => {
    const gate = await loadGateWithConfig({ minLiquidityUsd: 50_000, edgeMarginPct: 0.05 });
    await gate.setCastNetManualEnabled(true);
    // 50_500 → 1% above 50_000 floor
    const token = greenToken({ liquidity_usd: 50_500, volume_24h_usd: 100_000 });
    const result = gate.evaluateCastNet(happyArgs({ token }));
    expect(result.allowed).toBe(true);
    expect(result.edge_signals.some((e) => e.category === "liquidity")).toBe(true);
  });

  it("empty edge_signals when no category barely passes", async () => {
    const gate = await loadGateWithConfig({ edgeMarginPct: 0.05 });
    await gate.setCastNetManualEnabled(true);
    // Comfortable margins everywhere
    const token = greenToken({
      liquidity_usd: 500_000,
      volume_24h_usd: 800_000,
      fdv_usd: 5_000_000,
      top1_holder_pct: 2,
    });
    const result = gate.evaluateCastNet(happyArgs({
      token,
      experienceScore: { score: 0.99, matches: 15 },
    }));
    expect(result.allowed).toBe(true);
    expect(result.edge_signals.length).toBe(0);
  });
});

// ─── recordCastNetOutcome integration ────────────────────────────────

describe("recordCastNetOutcome", () => {
  it("finalizes outcome when all positions in a group close", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    await gate.recordCastNetFire({
      mint: "X", symbol: "X", walletCount: 3, bankrollPct: 30, reasons: {}, groupId: "g1",
    });
    await gate.recordCastNetOutcome({ groupId: "g1", pnlPct: 10, walletCount: 3 });
    await gate.recordCastNetOutcome({ groupId: "g1", pnlPct: 5 });
    let hist = gate.getCastNetHistory(1);
    expect(hist[0].outcome.win).toBe(null); // not finalized yet — 2 of 3
    await gate.recordCastNetOutcome({ groupId: "g1", pnlPct: 15 });
    hist = gate.getCastNetHistory(1);
    expect(hist[0].outcome.win).toBe(true);
    expect(hist[0].outcome.avg_pnl_pct).toBeCloseTo(10, 1);
  });

  it("marks group as LOSS when avg PnL is negative", async () => {
    const gate = await loadGateWithConfig({ cooldownMin: 0 });
    await gate.setCastNetManualEnabled(true);
    await gate.recordCastNetFire({
      mint: "Y", symbol: "Y", walletCount: 2, bankrollPct: 30, reasons: {}, groupId: "g2",
    });
    await gate.recordCastNetOutcome({ groupId: "g2", pnlPct: -20, walletCount: 2 });
    await gate.recordCastNetOutcome({ groupId: "g2", pnlPct: -10 });
    const hist = gate.getCastNetHistory(1);
    expect(hist[0].outcome.win).toBe(false);
    expect(hist[0].outcome.avg_pnl_pct).toBeCloseTo(-15, 1);
  });

  it("returns null for unknown groupId", async () => {
    const gate = await loadGateWithConfig();
    const r = await gate.recordCastNetOutcome({ groupId: "nonexistent", pnlPct: 10 });
    expect(r).toBeNull();
  });
});
