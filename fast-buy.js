/**
 * Fast-track entry path — bypasses the LLM agentLoop for unambiguous BUYs
 * to cut entry latency from ~5-30s (LLM) down to ~500ms (network only).
 *
 * Design: this is a pre-LLM lane in the screening cycle, NOT a separate cron.
 * The screening cycle gathers candidates as usual, then for each one runs
 * shouldFastBuy(). If a candidate clears the deterministic gate it gets
 * deployed immediately via executeFastBuy() through Jupiter and removed from the LLM pool.
 * Remaining candidates fall through to the LLM for nuanced judgment.
 *
 * Limits:
 *  - True sub-second entries need a mempool/geyser stream (item #6 on the
 *    roadmap). This path is bounded by how often the screening cycle runs.
 *  - The deterministic gate is intentionally STRICT — false positives here
 *    spend real SOL without LLM oversight, so defaults are conservative.
 *    Tune via user-config.json `fastTrack` block.
 *  - Disabled by default. Opt in with `fastTrack.enabled: true`.
 */

import { swapToken } from "./tools/jupiter.js";
import { trackPosition } from "./state.js";
import { recordSwapOutcome } from "./kill-switch.js";
import {
  startTimer, elapsedMs, recordLatency, recordCounter,
} from "./metrics.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { recordExecutionQuality } from "./execution-quality-memory.js";

const DEFAULT_GATE = {
  enabled: false,
  maxRugScore: 20,       // strict — rug heuristic must be near-clean
  minMcap: 150_000,      // avoid sub-pump.fun chaos tier
  maxMcap: 5_000_000,    // skip past-prime tier
  minVolumeUsd: 50_000,  // need real liquidity
  minSmartInflowUsd: 0,  // optional: 0 disables this check
  maxAgeMinutes: null,   // optional: null disables
  maxFlags: 0,           // 4-filter protocol must yield zero flags
};

/**
 * Pure decision function — returns { ok: boolean, reason: string }.
 * Token shape comes from the screening pipeline:
 *   { mint, symbol, mcap, volume, rug_score, flags, age_minutes,
 *     smart_inflow_usd, ... }
 */
export function shouldFastBuy(token, fastTrackConfig = {}) {
  const gate = { ...DEFAULT_GATE, ...fastTrackConfig };
  if (!gate.enabled) return { ok: false, reason: "fast-track disabled" };
  if (!token || !token.mint) return { ok: false, reason: "missing token data" };

  if (Number.isFinite(token.rug_score) && token.rug_score > gate.maxRugScore) {
    return { ok: false, reason: `rug_score ${token.rug_score} > ${gate.maxRugScore}` };
  }
  if (Number.isFinite(token.mcap)) {
    if (token.mcap < gate.minMcap) return { ok: false, reason: `mcap ${token.mcap} < ${gate.minMcap}` };
    if (token.mcap > gate.maxMcap) return { ok: false, reason: `mcap ${token.mcap} > ${gate.maxMcap}` };
  }
  if (Number.isFinite(token.volume) && token.volume < gate.minVolumeUsd) {
    return { ok: false, reason: `volume ${token.volume} < ${gate.minVolumeUsd}` };
  }
  if (gate.minSmartInflowUsd > 0) {
    const inflow = Number(token.smart_inflow_usd ?? 0);
    if (inflow < gate.minSmartInflowUsd) {
      return { ok: false, reason: `smart_inflow ${inflow} < ${gate.minSmartInflowUsd}` };
    }
  }
  if (gate.maxAgeMinutes != null && Number.isFinite(token.age_minutes)) {
    if (token.age_minutes > gate.maxAgeMinutes) {
      return { ok: false, reason: `age ${token.age_minutes}m > ${gate.maxAgeMinutes}m` };
    }
  }
  if (Number.isFinite(token.flags?.length) && token.flags.length > gate.maxFlags) {
    return { ok: false, reason: `flags ${token.flags.length} > ${gate.maxFlags}` };
  }
  return { ok: true, reason: "passed all fast-track gates" };
}

/**
 * Execute a fast-track BUY. Records swap outcome, kill-switch counter, and
 * a "fast-track" pool tag so post-hoc analysis can compare its P&L vs LLM
 * picks (filter state.json positions by pool === "fast-track").
 *
 * Caller passes `solPriceUsd` so we can record initial_value_usd without an
 * extra wallet call; the screening cycle already has the price snapshot.
 */
export async function executeFastBuy({
  token,
  deployAmountSol,
  slippage = 1.0,
  solPriceUsd = 0,
  wallet = null,
  walletAddress = null,
} = {}) {
  if (!token?.mint) {
    return { success: false, error: "missing token.mint" };
  }
  if (!(deployAmountSol > 0)) {
    return { success: false, error: "deployAmountSol must be > 0" };
  }

  if (config.trading?.confirmMode && process.env.DRY_RUN !== "true") {
    recordCounter("fast_buy_blocked_confirm_mode");
    return {
      success: false,
      blocked: true,
      pending_confirmation: true,
      error: "confirmMode active: fast-track BUY must be approved via pending intent",
    };
  }

  const t = startTimer();
  recordCounter("fast_buy_attempted");

  const result = await swapToken({
    token_in: "SOL",
    token_out: token.mint,
    amount: deployAmountSol,
    slippage,
    wallet,
    wallet_address: walletAddress,
  });

  const succeeded = !!(result?.success || result?.dry_run);
  recordSwapOutcome({ success: succeeded });
  const latencyMs = elapsedMs(t);
  recordLatency("fast_buy_swap_ms", latencyMs);
  await recordExecutionQuality({
    walletAddress: result?.wallet_address || walletAddress || null,
    provider: result?.execution_provider || "auto",
    mode: "buy",
    split: false,
    marketCondition: token.market_condition || "UNKNOWN",
    slippage,
    success: succeeded,
    latencyMs,
  });

  if (succeeded) {
    recordCounter("fast_buy_succeeded");
    await trackPosition({
      position: token.mint,
      pool: "fast-track",          // distinct tag so analytics can isolate this path
      pool_name: token.symbol || token.mint.slice(0, 8),
      amount_sol: deployAmountSol,
      initial_value_usd: deployAmountSol * (solPriceUsd || 0),
      signal_snapshot: {
        mint: token.mint,
        symbol: token.symbol,
        market_condition: token.market_condition || "UNKNOWN",
        rug_score: token.rug_score || 0,
        conviction: token.conviction || null,
        regime: token.regime || null,
        workflow: token.workflow || null,
        kelly: token.kelly || null,
        execution_context: {
          wallet_address: result?.wallet_address || walletAddress || null,
          provider: result?.execution_provider || "auto",
          slippage,
        },
      },
      wallet_address: walletAddress,
    });
    log(
      "fast_buy",
      `FAST BUY ✓ ${token.symbol || token.mint.slice(0, 8)} @ ${deployAmountSol} SOL`
    );
  } else {
    recordCounter("fast_buy_failed");
    log(
      "fast_buy",
      `FAST BUY ✗ ${token.symbol || token.mint.slice(0, 8)} — ${result?.error || "unknown"}`
    );
  }

  return result;
}

/**
 * Process a list of screening candidates through the fast-track gate. Returns:
 *   {
 *     deployed:   [token...],   // BUYs that were executed
 *     remaining:  [token...],   // candidates the LLM should still consider
 *     skipped:    [{ token, reason }] // gate rejections, for telemetry
 *   }
 *
 * `maxNew` caps how many fast BUYs may fire in one cycle (defaults to 1) so
 * a single screening pass can't blow the deploy budget.
 */
export async function runFastTrackBatch({
  candidates = [],
  fastTrackConfig = {},
  deployAmountSol,
  solPriceUsd = 0,
  maxNew = 1,
  walletPlan = [],
} = {}) {
  const deployed = [];
  const skipped = [];
  const remaining = [];

  for (const token of candidates) {
    if (deployed.length >= maxNew) {
      remaining.push(token);
      continue;
    }
    const gate = shouldFastBuy(token, fastTrackConfig);
    if (!gate.ok) {
      skipped.push({ token, reason: gate.reason });
      remaining.push(token);
      continue;
    }
    const executionSlots = walletPlan.length > 0
      ? walletPlan.slice(0, Math.max(1, maxNew - deployed.length))
      : [null];
    let executedAny = false;
    const tokenBudgetSol = token.volatility_adjusted_size || deployAmountSol;
    const perWalletAmount = executionSlots.length > 1
      ? Number((tokenBudgetSol / executionSlots.length).toFixed(4))
      : tokenBudgetSol;

    for (const walletSlot of executionSlots) {
      if (deployed.length >= maxNew) break;
      const result = await executeFastBuy({
        token,
        deployAmountSol: walletSlot ? perWalletAmount : tokenBudgetSol,
        solPriceUsd,
        wallet: walletSlot?.keypair || null,
        walletAddress: walletSlot?.address || null,
      });
      if (result?.success || result?.dry_run) {
        deployed.push({ ...token, wallet_address: walletSlot?.address || result?.wallet_address || null });
        executedAny = true;
      } else if (!executedAny) {
        remaining.push(token);
        break;
      }
    }
  }

  return { deployed, remaining, skipped };
}
