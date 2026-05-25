/**
 * Devnet Faucet — auto-fund DEMO wallet with devnet SOL.
 *
 * Devnet SOL is free and unlimited. This module ensures the DEMO
 * wallet always has enough SOL to execute swaps on devnet.
 *
 * Usage:
 *   await ensureDevnetBalance(walletPubkey, minBalanceSol);
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { log } from "../logger.js";

const DEVNET_RPC = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const FAUCET_AMOUNT_SOL = 2;
const FAUCET_COOLDOWN_MS = 60_000; // max 1 airdrop per minute
let _lastAirdrop = 0;

/**
 * Request devnet SOL airdrop. Devnet faucet gives ~2 SOL per request.
 * Rate-limited to 1 request per 60 seconds (network limit).
 */
async function requestAirdrop(publicKey, amountSol = FAUCET_AMOUNT_SOL) {
  const conn = new Connection(DEVNET_RPC, "confirmed");
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  try {
    const sig = await conn.requestAirdrop(publicKey, lamports);
    // Wait for confirmation
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    log("devnet_faucet", `Airdrop ${amountSol} SOL → ${publicKey.toBase58().slice(0, 8)}… tx: ${sig.slice(0, 8)}…`);
    return { success: true, signature: sig, amount_sol: amountSol };
  } catch (e) {
    log("devnet_faucet_warn", `Airdrop failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Ensure the DEMO wallet has at least minBalanceSol.
 * Requests airdrop if balance is too low.
 */
export async function ensureDevnetBalance(walletPublicKey, minBalanceSol = 0.5) {
  if (!walletPublicKey) return { funded: false, reason: "no wallet key" };
  if (!process.env.RPC_URL?.includes("devnet") && process.env.EXECUTION_MODE !== "demo") {
    return { funded: false, reason: "not on devnet" };
  }

  // Cooldown check
  const now = Date.now();
  if (now - _lastAirdrop < FAUCET_COOLDOWN_MS) {
    return { funded: true, reason: "cooldown", cooldown_remaining_ms: FAUCET_COOLDOWN_MS - (now - _lastAirdrop) };
  }

  try {
    const conn = new Connection(DEVNET_RPC, "confirmed");
    const pubkey = typeof walletPublicKey === "string" ? new PublicKey(walletPublicKey) : walletPublicKey;
    const balance = await conn.getBalance(pubkey);
    const balanceSol = balance / LAMPORTS_PER_SOL;

    if (balanceSol >= minBalanceSol) {
      return { funded: true, balance_sol: balanceSol, reason: "sufficient" };
    }

    const needed = Math.max(FAUCET_AMOUNT_SOL, minBalanceSol - balanceSol + 0.5);
    _lastAirdrop = now;
    const result = await requestAirdrop(pubkey, needed);
    return { ...result, balance_before_sol: balanceSol };
  } catch (e) {
    return { funded: false, error: e.message };
  }
}

/**
 * Get current devnet balance for the demo wallet.
 */
export async function getDevnetBalance(walletPublicKey) {
  if (!walletPublicKey) return null;
  try {
    const conn = new Connection(DEVNET_RPC, "confirmed");
    const pubkey = typeof walletPublicKey === "string" ? new PublicKey(walletPublicKey) : walletPublicKey;
    const balance = await conn.getBalance(pubkey);
    return {
      sol: balance / LAMPORTS_PER_SOL,
      lamports: balance,
      rpc: DEVNET_RPC,
    };
  } catch (e) {
    return { error: e.message };
  }
}
