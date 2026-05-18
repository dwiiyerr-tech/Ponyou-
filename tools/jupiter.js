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

const ULTRA_BASE = "https://ultra-api.jup.ag";
const SOL_MINT   = "So11111111111111111111111111111111111111112";

function getWallet() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
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
export async function swapToken({ token_in, token_out, amount, slippage = 0.5, wallet: walletOverride = null }) {
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { token_in, token_out, amount, slippage },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    const wallet     = walletOverride || getWallet();
    const inputMint  = (token_in  === "SOL") ? SOL_MINT : token_in;
    const outputMint = (token_out === "SOL") ? SOL_MINT : token_out;
    const decimals   = await getDecimals(inputMint);
    const amountRaw  = Math.floor(amount * Math.pow(10, decimals)).toString();
    const slippageBps = Math.floor(slippage * 100);

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

    const orderRes = await fetch(orderUrl.toString(), { headers });
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
      amount_out: result.outputAmountResult ?? result.outputAmount ?? result.outAmount ?? null,
      fee_bps:    result.feeBps ?? null,
    };
  } catch (error) {
    log("swap_error", `Jupiter swap: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get token price via Jupiter Price API v2.
 */
export async function getJupiterPrice(mint) {
  try {
    const res  = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`);
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
    const res  = await fetch(url);
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
    return { tradeable: false, error: e.message };
  }
}
