// Regression tests for the exit-monitor + rug-monitor audit fixes.
//
// RM-1: detectLpMovement must not return NaN-driven medium when low is null.
// RM-7: createRugMonitor's holder-dump detection must compute deltas
//       between successive polls, not against the initial snapshot.
// GEM-1/GEM-5: attachExitMonitor must peel previous wrappers on re-attach
//       so re-entrant chains do not form.

import { describe, it, expect, vi } from "vitest";
import { detectLpMovement, detectHolderDump, createRugMonitor, SEVERITY } from "../rug-monitor.js";
import { attachExitMonitor } from "../geyser-exit-monitor.js";

describe("detectLpMovement — RM-1 NaN guard", () => {
  it("does not flag MEDIUM when low is null and high is null", () => {
    const sev = detectLpMovement({
      lpAtEntry: 1000,
      currentLp: 500, // -50%
      thresholds: { high: null, medium: -25, low: null },
    });
    // -50% drop should still cross the medium threshold (-25%).
    expect(sev).toBe(SEVERITY.MEDIUM);
  });

  it("falls back cleanly when only medium is configured", () => {
    const sev = detectLpMovement({
      lpAtEntry: 1000,
      currentLp: 900, // -10%
      thresholds: { high: null, medium: -25, low: null },
    });
    expect(sev).toBe(SEVERITY.NONE);
  });
});

describe("createRugMonitor — RM-7 holder-dump delta math", () => {
  it("does not inflate cumulative sold by repeated polls of same balance", async () => {
    // The bug: dump events were measured against the INITIAL snapshot, then
    // accumulated. N polls of the same current state produced N times the
    // real dump. With delta-between-polls semantics, only actual movement
    // between polls is recorded.
    const mint = "MintAAA111111111111111111111111111111111111";

    let currentHolders = [
      { wallet: "W1", balance: 1000 },
      { wallet: "W2", balance: 1000 },
    ];

    const fetchers = {
      // Drop holder W1 from 1000 → 500 once, then stay flat. The intuitive
      // dump is 500 tokens out of an initial total of 2000 = 25% drop.
      getLargestAccounts: vi.fn(async () => currentHolders),
      // Stubs that return non-firing values.
      getTokenBalance: async () => 0,
      getPoolLiquidityUsd: async () => 0,
      getMintAccount: async () => ({}),
    };

    const onHigh = vi.fn();
    const onMedium = vi.fn();
    const onLow = vi.fn();

    const monitor = createRugMonitor({
      geyserStream: null,
      config: {
        pollingIntervalSec: 99999, // we'll never auto-poll
        devSellThresholds: { high: -50, medium: -20, low: null },
        lpMovementThresholds: { high: -50, medium: -20, low: null },
        holderDumpThresholds: { high: -50, medium: -20, low: null },
      },
      callbacks: { onHigh, onMedium, onLow },
      fetchers,
    });

    monitor.attachPosition("pos:mint:dev", {
      mint,
      deployer_wallet: "DEV",
      deployer_balance_at_entry: 0,
      deployer_token_account: null, // skip geyser sub
      lp_address: null,
      lp_usd_at_entry: 0,
      authorities: { mint_authority: null, freeze_authority: null },
      top_holders_snapshot: [
        { wallet: "W1", balance: 1000 },
        { wallet: "W2", balance: 1000 },
      ],
    });

    // Reach into the private state to drive _pollOnce directly. There is no
    // public "poll now" hook, so we use a tiny shim: poll N times by calling
    // an exposed via setting pollingIntervalSec to ~0 and waiting? Simpler:
    // call the internal poll via setTimeout flush.
    // Since polling is scheduled inside the module, we instead just invoke
    // the public callback path by polling fetchers manually. Easiest path:
    // shorten the polling interval and run real timers briefly.
    // For determinism, we rebuild monitor with very tight interval and
    // count events after 3 ticks.
    monitor.shutdown();

    // Re-run with short interval and observe.
    const onHigh2 = vi.fn();
    const onMedium2 = vi.fn();
    const onLow2 = vi.fn();
    const monitor2 = createRugMonitor({
      geyserStream: null,
      config: {
        pollingIntervalSec: 0.001, // 1ms
        devSellThresholds: { high: -50, medium: -20, low: null },
        lpMovementThresholds: { high: -50, medium: -20, low: null },
        holderDumpThresholds: { high: -50, medium: -20, low: null },
      },
      callbacks: { onHigh: onHigh2, onMedium: onMedium2, onLow: onLow2 },
      fetchers,
    });
    monitor2.attachPosition("pos:mint:dev", {
      mint,
      deployer_wallet: "DEV",
      deployer_balance_at_entry: 0,
      deployer_token_account: null,
      lp_address: null,
      lp_usd_at_entry: 0,
      authorities: { mint_authority: null, freeze_authority: null },
      top_holders_snapshot: [
        { wallet: "W1", balance: 1000 },
        { wallet: "W2", balance: 1000 },
      ],
    });

    // Drop W1 once.
    currentHolders = [
      { wallet: "W1", balance: 500 },
      { wallet: "W2", balance: 1000 },
    ];

    // Let multiple polls run.
    await new Promise(r => setTimeout(r, 80));
    monitor2.shutdown();

    // With the OLD logic (snapshot-vs-current), ~10 polls × 500-token delta
    // = 5000 sold from a 2000 total → -250% deltaPct → would fire HIGH.
    // With the FIX (poll-to-poll delta), only the FIRST poll observes the
    // real drop (-500 between snapshot and first observed value if W1 was
    // seen previously; otherwise no delta is recorded for the first-seen
    // wallet). Subsequent polls see W1=500 unchanged → no new events.
    //
    // So HIGH must not fire purely from repeated polling on flat state.
    expect(onHigh2).not.toHaveBeenCalled();
  });
});

describe("attachExitMonitor — GEM-1/GEM-5 re-attach safety", () => {
  it("peels the previous wrapper on re-attach so events fire once", async () => {
    const events = [];
    const baseHandler = vi.fn(async (evt) => { events.push({ tag: "base", evt }); });

    // Mock stream with a base onEvent.
    const stream = { onEvent: baseHandler };

    const cleanup1 = attachExitMonitor(
      stream,
      () => [{ mint: "MintAAA" }],
      {},
    );
    const cleanup2 = attachExitMonitor(
      stream,
      () => [{ mint: "MintAAA" }],
      {},
    );

    await stream.onEvent({ kind: "swap", token_in: "MintAAA", token_out: "So11111111111111111111111111111111111111112" });

    // Base handler should fire exactly once — without peeling, the second
    // wrapper would invoke the first wrapper, which would in turn invoke
    // base, producing a duplicate call.
    expect(baseHandler).toHaveBeenCalledTimes(1);

    cleanup2();
    cleanup1();
  });
});
