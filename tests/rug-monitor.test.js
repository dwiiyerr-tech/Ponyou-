import { describe, expect, it } from "vitest";
import { SEVERITY, aggregateSeverity, shouldEmit } from "../rug-monitor.js";

describe("severity engine", () => {
  it("aggregates per-detector severity by max", () => {
    expect(aggregateSeverity({ a: SEVERITY.LOW, b: SEVERITY.HIGH })).toBe(SEVERITY.HIGH);
    expect(aggregateSeverity({ a: SEVERITY.NONE, b: SEVERITY.NONE })).toBe(SEVERITY.NONE);
    expect(aggregateSeverity({})).toBe(SEVERITY.NONE);
  });

  it("emits only on strict upgrade, never downgrade", () => {
    expect(shouldEmit(SEVERITY.MEDIUM, SEVERITY.LOW)).toBe(true);
    expect(shouldEmit(SEVERITY.HIGH, SEVERITY.MEDIUM)).toBe(true);
    expect(shouldEmit(SEVERITY.MEDIUM, SEVERITY.MEDIUM)).toBe(false);
    expect(shouldEmit(SEVERITY.LOW, SEVERITY.HIGH)).toBe(false);
    expect(shouldEmit(SEVERITY.NONE, SEVERITY.LOW)).toBe(false);
  });
});

import { detectDevSell } from "../rug-monitor.js";

describe("detectDevSell", () => {
  const thresholds = { low: -5, medium: -20, high: -50 };

  it("returns NONE when delta is positive or zero", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 1100, thresholds })).toBe(SEVERITY.NONE);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 1000, thresholds })).toBe(SEVERITY.NONE);
  });

  it("returns LOW for 5-20% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 940, thresholds })).toBe(SEVERITY.LOW);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 810, thresholds })).toBe(SEVERITY.LOW);
  });

  it("returns MEDIUM for 20-50% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 790, thresholds })).toBe(SEVERITY.MEDIUM);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 510, thresholds })).toBe(SEVERITY.MEDIUM);
  });

  it("returns HIGH for >=50% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 500, thresholds })).toBe(SEVERITY.HIGH);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 0, thresholds })).toBe(SEVERITY.HIGH);
  });

  it("returns NONE for invalid entry balance", () => {
    expect(detectDevSell({ balanceAtEntry: 0, currentBalance: 100, thresholds })).toBe(SEVERITY.NONE);
    expect(detectDevSell({ balanceAtEntry: null, currentBalance: 100, thresholds })).toBe(SEVERITY.NONE);
  });
});

import { detectLpMovement, BURN_ADDRESSES, LP_PROGRAMS } from "../rug-monitor.js";

describe("detectLpMovement", () => {
  const thresholds = { low: -20, medium: -50, high: null };
  const deployer = "Dep111111111111111111111111111111111111111";

  it("returns NONE when LP unchanged", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 100000, thresholds })).toBe(SEVERITY.NONE);
  });
  it("returns NONE for <20% drop, LOW at 20%+", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 85000, thresholds })).toBe(SEVERITY.NONE);
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 79000, thresholds })).toBe(SEVERITY.LOW);
  });
  it("returns MEDIUM for 20-50% drop", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 60000, thresholds })).toBe(SEVERITY.MEDIUM);
  });
  it("returns HIGH for >50% drop", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 40000, thresholds: { low: -20, medium: -50, high: -50 } })).toBe(SEVERITY.HIGH);
  });
  it("returns NONE when LP transfer goes to known burn", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 0, transferTo: "1nc1nerator11111111111111111111111111111111", thresholds })).toBe(SEVERITY.NONE);
  });
  it("returns HIGH on removeLiquidity by deployer regardless of drop", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 95000, removeLiquidityBy: deployer, deployerWallet: deployer, thresholds })).toBe(SEVERITY.HIGH);
  });
  it("exposes burn addresses + LP programs", () => {
    expect(BURN_ADDRESSES).toContain("1nc1nerator11111111111111111111111111111111");
    expect(LP_PROGRAMS.raydiumV4).toBe("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  });
});

import { detectAuthorityChange } from "../rug-monitor.js";

describe("detectAuthorityChange", () => {
  it("returns NONE when both authorities unchanged", () => {
    expect(detectAuthorityChange({ atEntry: { mint_authority: null, freeze_authority: null }, current: { mint_authority: null, freeze_authority: null } })).toBe(SEVERITY.NONE);
  });
  it("returns HIGH when mint authority null -> address", () => {
    expect(detectAuthorityChange({ atEntry: { mint_authority: null, freeze_authority: null }, current: { mint_authority: "Auth111111111111111111111111111111111111111", freeze_authority: null } })).toBe(SEVERITY.HIGH);
  });
  it("returns HIGH when freeze authority null -> address", () => {
    expect(detectAuthorityChange({ atEntry: { mint_authority: null, freeze_authority: null }, current: { mint_authority: null, freeze_authority: "Auth222222222222222222222222222222222222222" } })).toBe(SEVERITY.HIGH);
  });
  it("returns LOW when authority transferred to burn", () => {
    expect(detectAuthorityChange({ atEntry: { mint_authority: "Auth1111111111111111111111111111111111111111", freeze_authority: null }, current: { mint_authority: "1nc1nerator11111111111111111111111111111111", freeze_authority: null } })).toBe(SEVERITY.LOW);
  });
});

import { detectHolderDump } from "../rug-monitor.js";

describe("detectHolderDump", () => {
  const thresholds = { low: -10, medium: -25, high: -50 };
  const now = 1_700_000_000_000;
  const ago = (ms) => now - ms;

  it("returns NONE when no events", () => {
    expect(detectHolderDump({ snapshotTotal: 10_000_000, events: [], windowMs: 5*60_000, nowMs: now, thresholds })).toBe(SEVERITY.NONE);
  });
  it("ignores events older than window", () => {
    expect(detectHolderDump({ snapshotTotal: 10_000_000, events: [{ tsMs: ago(10*60_000), deltaTokens: -3_000_000 }], windowMs: 5*60_000, nowMs: now, thresholds })).toBe(SEVERITY.NONE);
  });
  it("returns LOW for 10-25% cumulative dump in window", () => {
    expect(detectHolderDump({ snapshotTotal: 10_000_000, events: [{ tsMs: ago(60_000), deltaTokens: -700_000 }, { tsMs: ago(30_000), deltaTokens: -600_000 }], windowMs: 5*60_000, nowMs: now, thresholds })).toBe(SEVERITY.LOW);
  });
  it("returns MEDIUM for 25-50% dump", () => {
    expect(detectHolderDump({ snapshotTotal: 10_000_000, events: [{ tsMs: ago(30_000), deltaTokens: -3_500_000 }], windowMs: 5*60_000, nowMs: now, thresholds })).toBe(SEVERITY.MEDIUM);
  });
  it("returns HIGH for >=50% dump", () => {
    expect(detectHolderDump({ snapshotTotal: 10_000_000, events: [{ tsMs: ago(30_000), deltaTokens: -6_000_000 }], windowMs: 5*60_000, nowMs: now, thresholds })).toBe(SEVERITY.HIGH);
  });
  it("ignores positive (inbound) deltas", () => {
    expect(detectHolderDump({ snapshotTotal: 10_000_000, events: [{ tsMs: ago(60_000), deltaTokens: 5_000_000 }, { tsMs: ago(30_000), deltaTokens: -1_500_000 }], windowMs: 5*60_000, nowMs: now, thresholds })).toBe(SEVERITY.LOW);
  });
});

import { createRugMonitor } from "../rug-monitor.js";
import { vi } from "vitest";

const makeStubs = () => ({
  geyserStream: { subscribe: vi.fn().mockReturnValue("subid"), unsubscribe: vi.fn() },
  config: {
    enabled: true,
    pollingIntervalSec: 30,
    devSellThresholds: { low: -5, medium: -20, high: -50 },
    lpMovementThresholds: { low: -20, medium: -50, high: null },
    holderDumpThresholds: { low: -10, medium: -25, high: -50 },
    actions: { low: { type: "tighten_trail" }, medium: { type: "sell_partial" }, high: { type: "sell_all" } },
  },
  callbacks: { onLow: vi.fn(), onMedium: vi.fn(), onHigh: vi.fn() },
  fetchers: { getMintAccount: vi.fn(), getTokenBalance: vi.fn(), getLargestAccounts: vi.fn(), getPoolLiquidityUsd: vi.fn() },
});

describe("createRugMonitor lifecycle", () => {

  const baseMeta = (overrides = {}) => ({
    mint: "M", deployer_wallet: "D", lp_address: "L",
    top_holders_snapshot: [],
    authorities: { mint_authority: null, freeze_authority: null },
    entry_ts: 1,
    ...overrides,
  });

  it("attachPosition stores metadata and is idempotent", () => {
    const s = makeStubs();
    const rm = createRugMonitor(s);
    rm.attachPosition("M::W", baseMeta());
    rm.attachPosition("M::W", baseMeta());
    expect(rm.getMonitoredPositions()).toHaveLength(1);
    rm.shutdown();
  });

  it("detachPosition removes state", () => {
    const s = makeStubs();
    const rm = createRugMonitor(s);
    rm.attachPosition("M::W", baseMeta());
    rm.detachPosition("M::W");
    expect(rm.getMonitoredPositions()).toHaveLength(0);
  });

  it("detachPosition for unknown key is a no-op", () => {
    const s = makeStubs();
    const rm = createRugMonitor(s);
    expect(() => rm.detachPosition("X::Y")).not.toThrow();
  });

  it("shutdown detaches all positions", () => {
    const s = makeStubs();
    const rm = createRugMonitor(s);
    rm.attachPosition("M1::W", baseMeta({ mint: "M1" }));
    rm.attachPosition("M2::W", baseMeta({ mint: "M2" }));
    rm.shutdown();
    expect(rm.getMonitoredPositions()).toHaveLength(0);
  });
});

describe("polling fallback", () => {
  it("calls fetchers and emits HIGH on dev dump detected via polling", async () => {
    vi.useFakeTimers();
    const s = makeStubs();
    s.fetchers.getTokenBalance = vi.fn().mockResolvedValue(0);
    s.fetchers.getMintAccount = vi.fn().mockResolvedValue({ mint_authority: null, freeze_authority: null });
    s.fetchers.getLargestAccounts = vi.fn().mockResolvedValue([]);
    s.fetchers.getPoolLiquidityUsd = vi.fn().mockResolvedValue(25000);
    const rm = createRugMonitor(s);
    rm.attachPosition("M::W", {
      mint: "M", deployer_wallet: "D", lp_address: "L",
      top_holders_snapshot: [{ wallet: "H1", balance: 100 }],
      authorities: { mint_authority: null, freeze_authority: null },
      lp_usd_at_entry: 25000,
      deployer_balance_at_entry: 1000,
      entry_ts: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(s.callbacks.onHigh).toHaveBeenCalled();
    const [posKey, signalType, meta] = s.callbacks.onHigh.mock.calls[0];
    expect(posKey).toBe("M::W");
    expect(signalType).toBe("dev_sell");
    expect(meta.source).toBe("polling");
    rm.shutdown();
    vi.useRealTimers();
  });
});

describe("geyser event routing", () => {
  it("emits HIGH on dev_sell when geyser pushes balance to 0", () => {
    const s = makeStubs();
    let onDeployerAccount;
    s.geyserStream.subscribe = vi.fn((spec, handler) => {
      if (spec.account === "DeployerTokenAcct") onDeployerAccount = handler;
      return `sub-${spec.kind}`;
    });
    const rm = createRugMonitor(s);
    rm.attachPosition("M::W", {
      mint: "M", deployer_wallet: "D", deployer_token_account: "DeployerTokenAcct", lp_address: "L",
      top_holders_snapshot: [],
      authorities: { mint_authority: null, freeze_authority: null },
      deployer_balance_at_entry: 1000,
      lp_usd_at_entry: 25000,
      entry_ts: Date.now(),
    });
    onDeployerAccount({ tokenBalance: 0 });
    expect(s.callbacks.onHigh).toHaveBeenCalled();
    const [posKey, signalType, meta] = s.callbacks.onHigh.mock.calls[0];
    expect(posKey).toBe("M::W");
    expect(signalType).toBe("dev_sell");
    expect(meta.source).toBe("geyser");
    rm.shutdown();
  });
});
