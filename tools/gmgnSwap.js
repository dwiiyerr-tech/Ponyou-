/**
 * GMGN multi-chain swap adapter (Phase 3) — routes non-Solana swaps through the
 * GMGN trade API so Ponyou can execute on Base / BSC / Ethereum using the same
 * strategy/rug/sizing layer. The Solana path stays on Jupiter (tools/jupiter.js)
 * and is never touched by this module.
 *
 * SAFETY (per project rollout discipline + experiment #4):
 *   - HARD OFF by default. Live execution requires config.gmgn.execEnabled === true
 *     AND process.env.DRY_RUN !== "true". Otherwise every call returns a dry-run
 *     result with the SAME shape executeJupiterSwap returns, so downstream
 *     position-tracking is identical whether live or simulated.
 *   - The live path shells out to `gmgn-cli` (the sanctioned signer — it holds
 *     GMGN_PRIVATE_KEY locally and never sends it). We never hand-roll signing.
 *   - Anti-MEV is enabled by default but force-disabled on `base` (unsupported).
 *
 * Returns the executeJupiterSwap contract:
 *   { success, dry_run, hash, amount_out, chain, execution_provider, error? }
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { log } from "../logger.js";
import { config } from "../config.js";
import { recordCounter } from "../metrics.js";

const execFileAsync = promisify(execFile);

// Native currency token addresses per chain (VERIFIED from gmgn-swap skill table).
// "SOL" sentinel and the native EVM zero-address both mean "the chain's gas token".
const NATIVE_CURRENCY = {
  sol:  "So11111111111111111111111111111111111111112",
  bsc:  "0x0000000000000000000000000000000000000000", // BNB
  base: "0x0000000000000000000000000000000000000000", // ETH
  eth:  "0x0000000000000000000000000000000000000000", // ETH
};

// EVM tokens default to 18 decimals; native gas tokens too. Solana is handled by
// the Jupiter path, so this module only sees EVM amounts.
const EVM_DECIMALS = 18;

function isNativeSentinel(tok) {
  return tok === "SOL" || tok === "BNB" || tok === "ETH" || tok === "native" ||
    tok === "0x0000000000000000000000000000000000000000";
}

/** Resolve a token symbol/sentinel to the chain's on-chain address. */
function resolveToken(tok, chain) {
  if (isNativeSentinel(tok)) return NATIVE_CURRENCY[chain] || NATIVE_CURRENCY.sol;
  return tok;
}

/** Convert a human amount to smallest-unit string (EVM 18-decimals). */
function toSmallestUnit(amountHuman, decimals = EVM_DECIMALS) {
  // Avoid float drift: use BigInt on the integer + fractional split.
  const [intPart, fracRaw = ""] = String(amountHuman).split(".");
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  const whole = BigInt(intPart || "0") * (10n ** BigInt(decimals));
  return (whole + BigInt(frac || "0")).toString();
}

/**
 * Execute (or simulate) a swap on an EVM chain via GMGN.
 * @param {object} args - { token_in, token_out, amount, slippage, chain, wallet_address }
 */
export async function executeGmgnSwap(args = {}) {
  const chain = (args.chain || "sol").toLowerCase();
  const tokenIn = resolveToken(args.token_in, chain);
  const tokenOut = resolveToken(args.token_out, chain);
  const amount = Number(args.amount || 0);
  const slippage = Number(args.slippage ?? 0.1);
  const from = args.wallet_address || config.gmgn?.wallets?.[chain] || null;

  const liveEnabled = config.gmgn?.execEnabled === true && process.env.DRY_RUN !== "true";

  // ── Dry-run / disabled path — never moves funds ──────────────────────────
  if (!liveEnabled) {
    recordCounter("gmgn_swap_dry_run");
    return {
      success: true,
      dry_run: true,
      chain,
      execution_provider: "gmgn",
      hash: null,
      amount_out: null,
      would_swap: { token_in: tokenIn, token_out: tokenOut, amount, slippage, from, chain },
    };
  }

  // ── Live path — shell to gmgn-cli (sanctioned signer) ────────────────────
  if (!from) {
    return { success: false, error: `No wallet configured for chain ${chain} (set config.wallets.${chain})`, chain };
  }
  // amount arrives human-scaled (e.g. 0.01 ETH); GMGN wants smallest unit.
  const amountSmallest = toSmallestUnit(amount, EVM_DECIMALS);
  const antiMev = chain !== "base"; // anti-MEV unsupported on base

  const cliArgs = [
    "swap",
    "--chain", chain,
    "--from", from,
    "--input-token", tokenIn,
    "--output-token", tokenOut,
    "--amount", amountSmallest,
    "--slippage", String(slippage),
  ];
  if (antiMev) cliArgs.push("--anti-mev");

  try {
    const { stdout } = await execFileAsync("gmgn-cli", cliArgs, { timeout: 60_000 });
    const parsed = safeJson(stdout);
    const orderId = parsed?.order_id || parsed?.result?.order_id || null;
    if (!orderId) {
      return { success: false, error: `gmgn-cli swap returned no order_id: ${stdout.slice(0, 200)}`, chain };
    }
    // Poll until confirmed (pending → processed → confirmed | failed | expired).
    const final = await pollOrder(orderId, chain);
    recordCounter(final.success ? "gmgn_swap_confirmed" : "gmgn_swap_failed");
    return {
      success: final.success,
      dry_run: false,
      chain,
      execution_provider: "gmgn",
      hash: final.tx_hash || orderId,
      order_id: orderId,
      amount_out: final.output_amount ?? null,
      error: final.success ? undefined : (final.status || "swap not confirmed"),
    };
  } catch (e) {
    log("gmgn_swap_error", `${chain} swap failed: ${e.message}`);
    recordCounter("gmgn_swap_error");
    return { success: false, error: e.message, chain };
  }
}

/** Poll GMGN order status via gmgn-cli until terminal. */
async function pollOrder(orderId, chain, { maxTries = 20, intervalMs = 3000 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const { stdout } = await execFileAsync(
        "gmgn-cli",
        ["order", "get", "--chain", chain, "--order-id", orderId],
        { timeout: 30_000 }
      );
      const p = safeJson(stdout);
      const status = p?.status || p?.result?.status || "pending";
      if (status === "confirmed" || (p?.state === 30 && p?.status === "successful")) {
        return { success: true, status, tx_hash: p?.tx_hash || p?.result?.tx_hash, output_amount: p?.report?.output_amount };
      }
      if (status === "failed" || status === "expired") {
        return { success: false, status };
      }
    } catch (e) {
      log("gmgn_swap_warn", `order poll ${orderId}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { success: false, status: "poll_timeout" };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export { NATIVE_CURRENCY, resolveToken, toSmallestUnit };
