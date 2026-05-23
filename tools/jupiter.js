/**
 * Jupiter Ultra API — Swap execution for Solana.
 * Replaces GMGN swap with better routing, no API key required.
 *
 * Docs: https://dev.jup.ag/docs/ultra-api/
 */

import { VersionedTransaction, Keypair, Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getActiveWallet, getWalletByAddress } from "./wallet-manager.js";
import { submitSwapBundle, awaitBundleLanding, isJitoEnabled } from "./jito.js";
import { submitWithAdaptiveRetry } from "./jito-executor.js";
import { simulatePreflight } from "./tx-simulator.js";
import { getRpcQuorum, getFeeOracle } from "./exec-edge-singletons.js";

const ULTRA_BASE   = "https://ultra-api.jup.ag";
const JUPITER_V6   = "https://quote-api.jup.ag/v6";
const SOL_MINT     = "So11111111111111111111111111111111111111112";

function getWallet() {
  const active = getActiveWallet();
  if (active?.keypair) return active.keypair;
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("No wallet configured: set WALLET_PRIVATE_KEY or multiWallet in user-config.json");
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
}

// ── Jito swap path (Jupiter v6 quote → bundle via BlockEngine) ──────────────
async function swapViaJito({ inputMint, outputMint, amountRaw, slippageBps, wallet, executionContext = {} }) {
  if (!config.executionEdge?.enabled) {
    return legacyJitoFlow({ inputMint, outputMint, amountRaw, slippageBps, wallet });
  }
  const rpcQuorum = getRpcQuorum();
  const feeOracle = getFeeOracle();
  if (!rpcQuorum || !feeOracle) {
    return legacyJitoFlow({ inputMint, outputMint, amountRaw, slippageBps, wallet });
  }

  const quoteUrl = `${JUPITER_V6}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(10000) });
  if (!quoteRes.ok) throw new Error(`Jupiter v6 quote ${quoteRes.status}: ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter v6 quote: ${quote.error}`);

  const result = await submitWithAdaptiveRetry({
    builtTxFactory: async ({ priorityFee, blockhash: _bh }) => {
      const swapRes = await fetch(`${JUPITER_V6}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: false,
          computeUnitPriceMicroLamports: priorityFee,
          prioritizationFeeLamports: 0,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!swapRes.ok) throw new Error(`Jupiter v6 swap ${swapRes.status}: ${await swapRes.text()}`);
      const swapData = await swapRes.json();
      if (!swapData.swapTransaction) throw new Error("Jupiter v6 swap: no transaction returned");
      const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
      tx.sign([wallet]);
      return tx;
    },
    wallet,
    rpcQuorum,
    feeOracle,
    simulator: { simulatePreflight },
    jitoSubmit: async ({ tx, tip }) => submitSwapBundle({
      signedSwapTx: tx,
      wallet,
      recentBlockhash: tx.message.recentBlockhash,
      tipLamports: tip,
      region: config.jito.region || "fra",
      authToken: config.jito.authToken || null,
    }),
    jitoAwait: async ({ bundleId, timeoutMs }) => awaitBundleLanding({
      bundleId,
      region: config.jito.region || "fra",
      authToken: config.jito.authToken || null,
      timeoutMs,
    }),
    urgency: executionContext.urgency || "urgent",
    maxAttempts: config.executionEdge.executor.maxAttempts,
    attemptTimeoutMs: config.executionEdge.executor.attemptTimeoutMs,
    defaultCuLimit: config.executionEdge.executor.defaultCuLimit,
    maxCuLimit: config.executionEdge.executor.maxCuLimit,
    maxTipLamports: config.executionEdge.feeOracle.maxTipLamports,
    log,
  });

  log("swap", `exec_edge landed: tx=${result.hash} attempts=${result.attempts.length} tip=${result.total_tip_lamports} time=${result.landing_time_ms}ms`);
  return { hash: result.hash, amount_out: quote.outAmount ?? null, jito_bundle_id: result.hash, attempts: result.attempts, total_tip_lamports: result.total_tip_lamports };
}

// Legacy Jito path — used when executionEdge.enabled = false or singletons not ready
async function legacyJitoFlow({ inputMint, outputMint, amountRaw, slippageBps, wallet }) {
  const quoteUrl = `${JUPITER_V6}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(10000) });
  if (!quoteRes.ok) throw new Error(`Jupiter v6 quote ${quoteRes.status}: ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter v6 quote: ${quote.error}`);

  const swapRes = await fetch(`${JUPITER_V6}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 0 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!swapRes.ok) throw new Error(`Jupiter v6 swap ${swapRes.status}: ${await swapRes.text()}`);
  const swapData = await swapRes.json();
  if (!swapData.swapTransaction) throw new Error("Jupiter v6 swap: no transaction returned");
  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
  tx.sign([wallet]);
  const bundleId = await submitSwapBundle({ signedSwapTx: tx, wallet, recentBlockhash: tx.message.recentBlockhash, tipLamports: config.jito.tipLamports, region: config.jito.region || "fra", authToken: config.jito.authToken || null });
  const landing = await awaitBundleLanding({ bundleId, region: config.jito.region || "fra", authToken: config.jito.authToken || null, timeoutMs: 30_000 });
  if (!landing.landed) throw new Error(`Jito bundle not landed: ${JSON.stringify(landing.status?.err)}`);
  const hash = landing.status?.transactions?.[0] || bundleId;
  log("swap", `Jito bundle landed: ${bundleId} tx=${hash}`);
  return { hash, amount_out: quote.outAmount ?? null, jito_bundle_id: bundleId };
}

async function getDecimals(mint) {
  if (mint === SOL_MINT || mint === "SOL") return 9;
  try {
    const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    return info.value?.data?.parsed?.info?.decimals ?? 9;
  } catch {
    return 9;
  }
}

/**
 * Swap tokens via Jupiter Ultra API.
 * Supports SOL → Token and Token → SOL.
 */
export async function swapToken({ token_in, token_out, amount, slippage = 0.5, wallet: walletOverride = null, wallet_address = null, executionContext = {} }) {
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { token_in, token_out, amount, slippage, wallet_address },
      wallet_address,
      message: "DRY RUN — no transaction sent",
    };
  }

  const execCtx = executionContext && typeof executionContext === "object" ? executionContext : {};
  const approvedIntent = execCtx.approvedIntent === true || execCtx.source === "pending-intent";
  if (config.trading?.confirmMode && token_in === "SOL" && token_out && token_out !== "SOL" && !approvedIntent) {
    return {
      success: false,
      blocked: true,
      pending_confirmation: true,
      error: "confirmMode active: live BUY must be approved via pending intent",
      wallet_address,
      execution_context: execCtx,
    };
  }

  try {
    const walletFromAddress = wallet_address ? getWalletByAddress(wallet_address)?.keypair || null : null;
    const wallet      = walletOverride || walletFromAddress || getWallet();
    const activeWalletAddress = wallet_address || wallet.publicKey.toString();
    const inputMint   = (token_in  === "SOL") ? SOL_MINT : token_in;
    const outputMint  = (token_out === "SOL") ? SOL_MINT : token_out;
    const decimals    = await getDecimals(inputMint);
    const amountRaw   = Math.floor(amount * Math.pow(10, decimals)).toString();
    const slippageBps = Math.floor(slippage * 100);

    // ── Jito path (when enabled in config) ──────────────────────────
    if (isJitoEnabled(config)) {
      const { hash, amount_out, jito_bundle_id } = await swapViaJito({ inputMint, outputMint, amountRaw, slippageBps, wallet });
      log("swap", `Jito OK: ${amount} ${inputMint.slice(0,8)} → ${outputMint.slice(0,8)} | bundle=${jito_bundle_id}`);
      return {
        success: true,
        hash,
        token_in: inputMint,
        token_out: outputMint,
        amount,
        slippage,
        amount_out,
        jito_bundle_id,
        wallet_address: activeWalletAddress,
        execution_provider: "jito",
        execution_context: execCtx,
      };
    }

    // ── Step 1: Get order ──────────────────────────────────
    const orderUrl = new URL(`${ULTRA_BASE}/order`);
    orderUrl.searchParams.set("inputMint",    inputMint);
    orderUrl.searchParams.set("outputMint",   outputMint);
    orderUrl.searchParams.set("amount",       amountRaw);
    orderUrl.searchParams.set("taker",        wallet.publicKey.toString());
    orderUrl.searchParams.set("slippageBps",  slippageBps.toString());

    if (config.jupiter?.referralAccount) {
      orderUrl.searchParams.set("referralAccount", config.jupiter.referralAccount);
      orderUrl.searchParams.set("referralFeeBps", String(config.jupiter.referralFeeBps || 50));
    }

    const headers = { "Content-Type": "application/json" };
    if (config.jupiter?.apiKey) headers["Authorization"] = `Bearer ${config.jupiter.apiKey}`;

    const orderRes = await fetch(orderUrl.toString(), { headers, signal: AbortSignal.timeout(10000) });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Jupiter order error: ${orderRes.status} — ${body}`);
    }

    const order = await orderRes.json();
    if (!order.transaction) throw new Error("Jupiter returned no transaction");

    // ── Step 2: Sign ───────────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ── Step 3: Execute ────────────────────────────────────
    const execRes = await fetch(`${ULTRA_BASE}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        signedTransaction: signedTx,
        requestId: order.requestId,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!execRes.ok) {
      const body = await execRes.text();
      throw new Error(`Jupiter execute error: ${execRes.status} — ${body}`);
    }

    const result = await execRes.json();

    if (result.status === "Failed") {
      throw new Error(`Jupiter swap failed: ${result.error || JSON.stringify(result)}`);
    }

    const hash = result.signature;
    log("swap", `Jupiter swap OK: ${hash} | ${amount} ${inputMint.slice(0, 8)} → ${outputMint.slice(0, 8)}`);

    return {
      success:    true,
      hash,
      token_in:   inputMint,
      token_out:  outputMint,
      amount,
      slippage,
      wallet_address: activeWalletAddress,
      amount_out: result.outputAmountResult ?? result.outputAmount ?? result.outAmount ?? null,
      fee_bps:    result.feeBps ?? null,
      execution_provider: "jupiter_ultra",
      execution_context: execCtx,
    };
  } catch (error) {
    log("swap_error", `Jupiter swap: ${error.message}`);
    return { success: false, error: error.message, execution_provider: isJitoEnabled(config) ? "jito" : "jupiter_ultra", execution_context: execCtx };
  }
}

/**
 * Get token price via Jupiter Price API v2.
 */
export async function getJupiterPrice(mint) {
  try {
    const res  = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.data?.[mint]?.price ?? null;
  } catch (e) {
    log("jupiter_price_error", e.message);
    return null;
  }
}

/**
 * Check if a token is tradeable on Jupiter (quote exists).
 * Useful for honeypot detection.
 */
export async function checkJupiterQuote({ mint, amountSol = 0.01 }) {
  try {
    const amountLamports = Math.floor(amountSol * 1e9);
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${amountLamports}&slippageBps=500`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { tradeable: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { tradeable: false, error: data.error };
    return {
      tradeable:   true,
      price_impact: data.priceImpactPct,
      out_amount:  data.outAmount,
      route_plan:  data.routePlan?.length,
    };
  } catch (e) {
    return { tradeable: false, error: e.message, fetch_failed: true };
  }
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Fail-open pre-swap guard for Jupiter quote availability and price impact.
 */
export async function preSwapGuard({ mint, amountSol = 0.01 }) {
  try {
    const quote = await checkJupiterQuote({ mint, amountSol });
    if (quote.fetch_failed) {
      return { allowed: true, warn: "quote_check_failed" };
    }

    if (!quote.tradeable) {
      return { allowed: false, reason: `not_tradeable: ${quote.error || "unknown"}` };
    }

    const priceImpactPct = Number(quote.price_impact);
    if (Number.isFinite(priceImpactPct) && priceImpactPct > 15) {
      return { allowed: false, reason: `price_impact_too_high: ${formatPct(priceImpactPct)}%` };
    }

    return { allowed: true };
  } catch {
    return { allowed: true, warn: "quote_check_failed" };
  }
}
