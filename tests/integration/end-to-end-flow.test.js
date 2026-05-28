// End-to-end integration sketch — signal → buy → exit flow.
//
// SCOPE: this is a SCAFFOLD that exercises the key path through the audit
// fixes (MGMT-1 PnL, MGMT-2 per-exit isolation, MGMT-3 managed guard,
// trash-filter supply-field fix). It MOCKS the chain (Jupiter, RPC) so
// it stays in CI without real SOL. It does NOT yet exercise screening
// candidate enrichment, day-phase strategy switching, or pro-orchestrator
// runtime selection — those are TODOs at the end of this file.
//
// What this currently covers:
//   1. Trash-filter lets through a token missing the `supply` field (S3 fix)
//   2. checkManagedGuard blocks an LLM-initiated sell of a young position
//      (MGMT-3) but allows the same sell when rug_force_exit is set
//   3. LLM exit PnL computation falls back to "skip telemetry" when the
//      swap result lacks `amount_out` (MGMT-1 safe path)
//
// What this does NOT cover yet (TODOs, see comments at bottom):
//   - Full runManagementCycle exit loop (needs portfolio snapshot mock)
//   - Strategy switching mid-cycle
//   - Vault sweep trigger after profit
//   - Daily-trade-guard interactions
//   - Concurrent management + heartbeat firing

import { describe, it, expect, vi } from "vitest";

const MINT = "9xH72gnPGEf4HpDoiTrPDexJ7M5cQpUmwTm12P3Vpump";
const SOL  = "So11111111111111111111111111111111111111112";
const NOW  = 1_750_000_000_000;
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

describe("E2E sketch — signal entry path", () => {
  it("trash-filter does NOT hard-block a token whose supply field is absent (S3)", async () => {
    const { preScreenTrash } = await import("../../tools/trash-filter.js");
    // Typical CoinGecko / social-hunter signal: liquidity + mcap + swaps
    // populated, but supply not yet enriched.
    const signal = {
      mint: MINT,
      symbol: "PONYOU",                  // avoid scam-name patterns (TEST etc.)
      liquidity: 50_000,
      swaps: 100,
      mcap: 500_000,
      launchpad: "pumpfun",
      created_at: NOW / 1000 - 3600,
      // NOTE: no `supply` field — the regression we're guarding against
    };
    const result = preScreenTrash(signal);
    // The supply-missing case used to read `supply_invalid` and block.
    // After the fix it should NOT block for that reason. We allow OTHER
    // hard-block reasons (e.g. dust_liquidity) only if they're not the
    // supply check — assert the specific regression doesn't return.
    if (result.block) {
      expect(result.reason, "should not block specifically on supply_invalid").not.toBe("supply_invalid");
    } else {
      expect(result.block).toBe(false);
    }
  });

  it("explicit zero supply (real dust) IS still hard-blocked", async () => {
    const { preScreenTrash } = await import("../../tools/trash-filter.js");
    const signal = {
      mint: MINT,
      symbol: "PONYOU",
      liquidity: 50_000,
      swaps: 100,
      mcap: 500_000,
      launchpad: "pumpfun",
      created_at: NOW / 1000 - 3600,
      supply: 0,
    };
    const result = preScreenTrash(signal);
    expect(result.block).toBe(true);
    expect(result.reason).toBe("supply_invalid");
  });
});

describe("E2E sketch — managed-position guard path (MGMT-3)", () => {
  it("LLM sell of a young position is blocked by checkManagedGuard", async () => {
    const { checkManagedGuard } = await import("../../tools/executor.js");
    const trackedYoung = { deployed_at: minutesAgo(2) };
    const result = checkManagedGuard(
      { token_in: MINT, token_out: SOL },
      () => trackedYoung,
      { now: NOW },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/only 2\.0min old/);
  });

  it("LLM sell on the same position passes when rug_force_exit is set", async () => {
    const { checkManagedGuard } = await import("../../tools/executor.js");
    const trackedRug = { deployed_at: minutesAgo(2), rug_force_exit: true };
    const result = checkManagedGuard(
      { token_in: MINT, token_out: SOL },
      () => trackedRug,
      { now: NOW },
    );
    expect(result.pass).toBe(true);
  });

  it("LLM sell with bypass flag passes unconditionally", async () => {
    const { checkManagedGuard } = await import("../../tools/executor.js");
    const trackedYoung = { deployed_at: minutesAgo(2), partial_tp_done: true };
    const result = checkManagedGuard(
      { token_in: MINT, token_out: SOL, bypass_managed_guard: true },
      () => trackedYoung,
      { now: NOW },
    );
    expect(result.pass).toBe(true);
  });
});

describe("E2E sketch — LLM exit PnL classification (MGMT-1 safe path)", () => {
  // Replicates the inline computation that index.js does so the test can
  // assert behavior without spinning up the full cycle. Documented in the
  // acf408d commit body.
  function computeIsWin({ trackedPos, swapResult, solPriceUsd, isDryRun }) {
    const exitSolAmount = Number(swapResult?.amount_out || 0) / 1e9;
    const exitUsd = exitSolAmount * solPriceUsd;
    const entryUsd = Number(trackedPos?.initial_value_usd) || 0;
    const canComputePnl = !isDryRun && entryUsd > 0 && exitUsd > 0;
    const pnlPct = canComputePnl ? ((exitUsd - entryUsd) / entryUsd) * 100 : null;
    return pnlPct != null ? pnlPct > 0 : null;
  }

  it("derives win when exit USD > entry USD", () => {
    const isWin = computeIsWin({
      trackedPos: { initial_value_usd: 10 },
      swapResult: { amount_out: 0.15 * 1e9 }, // 0.15 SOL
      solPriceUsd: 200,                         // 0.15 × 200 = $30
      isDryRun: false,
    });
    expect(isWin).toBe(true);
  });

  it("derives loss when exit USD < entry USD", () => {
    const isWin = computeIsWin({
      trackedPos: { initial_value_usd: 50 },
      swapResult: { amount_out: 0.1 * 1e9 },   // 0.1 SOL = $20
      solPriceUsd: 200,
      isDryRun: false,
    });
    expect(isWin).toBe(false);
  });

  it("returns null (skip telemetry) when amount_out is missing", () => {
    const isWin = computeIsWin({
      trackedPos: { initial_value_usd: 10 },
      swapResult: {},                            // missing amount_out
      solPriceUsd: 200,
      isDryRun: false,
    });
    expect(isWin).toBeNull();
  });

  it("returns null when dry_run (no real exit value)", () => {
    const isWin = computeIsWin({
      trackedPos: { initial_value_usd: 10 },
      swapResult: { amount_out: 0.15 * 1e9 },
      solPriceUsd: 200,
      isDryRun: true,
    });
    expect(isWin).toBeNull();
  });
});

// ── TODOs for follow-up integration coverage ─────────────────────────────
//
// 1. Full runManagementCycle round-trip:
//    - vi.mock("../../tools/jupiter.js", () => ({
//        swapToken: vi.fn(async () => ({ success: true, amount_out: 0.15e9 })),
//      }))
//    - vi.mock("../../wallet.js") or whatever surfaces getPortfolioSnapshot
//    - Seed state.js with a tracked position
//    - Set SL at -10% on the strategy preset
//    - Push a portfolio snapshot where the position is at -15% PnL
//    - Drive runManagementCycle({ silent: true })
//    - Assert: recordClose was called, recordTrade(false), state.json updated
//
// 2. Strategy switch mid-cycle:
//    - Set active strategy = scalping
//    - Trigger market:update event with condition=DEAD
//    - Assert: orchestrator emits emergency_pause and no new entries fire
//
// 3. Vault sweep after profit:
//    - Set vault.pct = 0.20
//    - Close a winning trade with +50% PnL
//    - Assert: runVaultCycle fires within the same cycle, vault state has
//      the swept SOL
//
// 4. Daily-trade-guard cooldown:
//    - Set maxLossesPerDay = 1
//    - Close two losing trades back-to-back
//    - Assert: third buy attempt is blocked by checkAllGates("management")
//
// 5. Heartbeat → emergency_exit chain:
//    - Seed a tracked position with rug_force_exit = true
//    - Tick the heartbeat cron
//    - Assert: management:emergency_exit event fired and learning-agent
//      sees the rug classification correctly (LA-1 fix)
//
// 6. Concurrent guards:
//    - Fire two updateConfig calls in parallel
//    - Assert: both writes land (no lost-update) thanks to _configWriteLock
