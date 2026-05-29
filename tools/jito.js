/**
 * Jito BlockEngine integration — submit signed transactions as bundles to
 * jump the regular Solana mempool queue. This is the standard "priority lane"
 * for serious memecoin trading: a tipped bundle lands in the next leader
 * slot, sandwich attempts that rely on mempool sniping mostly can't see it,
 * and you compete for inclusion against other tipped bundles instead of
 * against the entire mempool.
 *
 * What this scaffold does:
 *  - rotates through the 8 published tip accounts (Jito picks one per slot
 *    randomly anyway; we shuffle on our side so a single hot account doesn't
 *    accumulate all our tips)
 *  - builds a tip transaction the agent's wallet signs
 *  - posts a bundle of base58-encoded signed txs to the BlockEngine RPC
 *  - polls getBundleStatuses for confirmation
 *
 * What it does NOT do (yet):
 *  - integrate into jupiter.js swap path — that requires rebuilding the
 *    Jupiter order ourselves (currently /execute handles signing + sending).
 *    Wiring this into the live swap is a one-line config flip plus a few
 *    lines in jupiter.js; left out of this scaffold so the swap path stays
 *    exactly as it is until the user explicitly opts in.
 *  - dynamic tip pricing based on mempool congestion
 *  - bundle simulation before submission
 *
 * Setup:
 *   user-config.json:
 *     "jito": {
 *       "enabled": true,
 *       "region": "fra" | "ny" | "ams" | "tyo",
 *       "tipLamports": 100000        // 0.0001 SOL — adjust per network heat
 *     }
 *
 * Free tier (no auth) is available at all 4 regions. For higher rate limits
 * register at https://jito.wtf and pass an Authorization header.
 */

import {
  SystemProgram,
  Transaction,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import { randomBytes } from "crypto";
import bs58 from "bs58";
import { log } from "../logger.js";
import { recordCounter, recordLatency, startTimer, elapsedMs } from "../metrics.js";

// Track in-flight bundle IDs to prevent double-spend when multi-region
// failover re-submits the same signed transaction.
const _submittedBundles = new Map(); // idempotencyKey → { bundleId, region, ts }
const IDEMPOTENCY_TTL_MS = 300_000; // 5 min
let _idempotencyPruneTimer = null;

function pruneIdempotencyCache() {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [key, v] of _submittedBundles) {
    if (v.ts < cutoff) _submittedBundles.delete(key);
  }
}

function idempotencyKey(tx) {
  // Derive a stable key from the first signature so re-submissions of the
  // same signed tx are caught even if serialized differently. Handles both:
  //   - legacy Transaction:  signatures[0] = { signature: Buffer|null, publicKey }
  //   - VersionedTransaction: signatures[0] = Uint8Array (the raw signature)
  // The earlier version only read `.signature`, so it returned null for every
  // VersionedTransaction (what Jupiter produces) — silently disabling dedup on
  // the real swap path.
  try {
    const sig0 = Array.isArray(tx?.signatures) ? tx.signatures[0] : null;
    if (!sig0) return null;
    const raw = sig0.signature ?? sig0; // legacy wraps it; versioned IS the bytes
    if ((raw instanceof Uint8Array || Buffer.isBuffer(raw)) && raw.length > 0) {
      // Skip the all-zero placeholder of an unsigned slot — otherwise every
      // unsigned tx would collapse to the same key.
      let signed = false;
      for (const b of raw) { if (b !== 0) { signed = true; break; } }
      if (signed) return bs58.encode(raw);
    }
  } catch {}
  return null;
}

// Published Jito tip accounts. One is selected per bundle. Source:
// https://docs.jito.wtf/lowlatencytxnsend/#tip-amount
const TIP_ACCOUNTS = Object.freeze([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDcMH",
  "ADuUkR4vqLUMWXxW9gh6D6L8pivKeVBBSXqJSpYukSjr",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

const REGION_ENDPOINTS = Object.freeze({
  fra: "https://frankfurt.mainnet.block-engine.jito.wtf",
  ny:  "https://ny.mainnet.block-engine.jito.wtf",
  ams: "https://amsterdam.mainnet.block-engine.jito.wtf",
  tyo: "https://tokyo.mainnet.block-engine.jito.wtf",
});

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Pick a tip account uniformly at random. Stateless — relies on Math.random()
 * being good enough for "don't always hit the same account".
 */
export function pickTipAccount() {
  const idx = Math.floor(Math.random() * TIP_ACCOUNTS.length);
  return new PublicKey(TIP_ACCOUNTS[idx]);
}

export function getJitoEndpoint(region = "fra") {
  return REGION_ENDPOINTS[region] || REGION_ENDPOINTS.fra;
}

export function isJitoEnabled(config) {
  return !!(
    config?.jito?.enabled &&
    Number.isFinite(config.jito.tipLamports) &&
    config.jito.tipLamports > 0
  );
}

export function validateJitoConfig(config) {
  if (!config?.jito?.enabled) return { valid: true, enabled: false };
  const errors = [];
  if (!Number.isFinite(config.jito.tipLamports) || config.jito.tipLamports <= 0) {
    errors.push("jito.tipLamports must be a positive integer (lamports)");
  }
  const region = config.jito.region || "fra";
  if (!REGION_ENDPOINTS[region]) {
    errors.push(`jito.region must be one of: ${Object.keys(REGION_ENDPOINTS).join(", ")}`);
  }
  return { valid: errors.length === 0, enabled: true, errors };
}

// ─── Transaction building ─────────────────────────────────────────

/**
 * Build a signed legacy Transaction that transfers tipLamports from wallet
 * to a Jito tip account.
 *
 * @param {object} opts
 * @param {Keypair} opts.wallet
 * @param {string} opts.recentBlockhash
 * @param {number} opts.tipLamports
 * @param {PublicKey} [opts.tipAccount] override the auto-rotated tip account
 * @returns {Transaction} signed tx
 */
export function buildTipTransaction({
  wallet,
  recentBlockhash,
  tipLamports,
  tipAccount = null,
}) {
  if (!wallet?.publicKey) throw new Error("buildTipTransaction: wallet required");
  if (!recentBlockhash) throw new Error("buildTipTransaction: recentBlockhash required");
  if (!Number.isFinite(tipLamports) || tipLamports <= 0) {
    throw new Error("buildTipTransaction: tipLamports must be > 0");
  }

  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tipAccount || pickTipAccount(),
      lamports: tipLamports,
    })
  );
  tx.recentBlockhash = recentBlockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet);
  return tx;
}

/**
 * Serialize a (Transaction | VersionedTransaction) to base58 for the bundle
 * payload. Jito expects base58 even though Solana usually uses base64 — see
 * https://docs.jito.wtf/lowlatencytxnsend/#sendbundle.
 */
export function serializeTxForBundle(tx) {
  if (!tx) throw new Error("serializeTxForBundle: tx required");
  const raw = typeof tx.serialize === "function" ? tx.serialize() : tx;
  return bs58.encode(raw);
}

// ─── BlockEngine RPC ──────────────────────────────────────────────

async function jitoRpc({ region, method, params, authToken = null }) {
  const url = `${getJitoEndpoint(region)}/api/v1/bundles`;
  const headers = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) {
    recordCounter(`jito_${method}_http_${res.status}`);
    throw new Error(`Jito ${method} ${res.status}: ${text}`);
  }
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Jito ${method} returned non-JSON: ${text.slice(0, 200)}`); }
  if (json.error) {
    recordCounter("jito_rpc_error");
    throw new Error(`Jito ${method} error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

/**
 * Submit a bundle of 1-5 signed transactions. Returns the bundle ID.
 */
export async function sendBundle({
  signedTxs,
  region = "fra",
  authToken = null,
  idempotencyKey: extKey = null,
} = {}) {
  if (!Array.isArray(signedTxs) || signedTxs.length === 0 || signedTxs.length > 5) {
    throw new Error("sendBundle: 1-5 transactions required");
  }

  // Dedup: if this signed tx (by first signature) was already submitted,
  // return the existing bundle ID instead of re-submitting — prevents
  // double-spend from multi-region failover retries.
  const dedupKey = extKey || idempotencyKey(signedTxs[0]);
  if (dedupKey) {
    const existing = _submittedBundles.get(dedupKey);
    if (existing) {
      log("jito", `Bundle dedup: ${dedupKey.slice(0, 16)}... already submitted as ${existing.bundleId} (region=${existing.region})`);
      recordCounter("jito_bundle_dedup");
      return existing.bundleId;
    }
  }

  const t0 = startTimer();
  const b58s = signedTxs.map(serializeTxForBundle);
  recordCounter("jito_bundle_attempted");
  try {
    const bundleId = await jitoRpc({
      region,
      method: "sendBundle",
      params: [b58s],
      authToken,
    });
    recordLatency("jito_send_bundle_ms", elapsedMs(t0));

    // Track for dedup
    if (dedupKey) {
      _submittedBundles.set(dedupKey, { bundleId, region, ts: Date.now() });
      // JT-2: schedule the prune sweep once, and unref() so the timer
      // doesn't keep the process alive on shutdown when no bundles are
      // in flight.
      if (!_idempotencyPruneTimer) {
        _idempotencyPruneTimer = setInterval(pruneIdempotencyCache, 60_000);
        _idempotencyPruneTimer.unref?.();
      }
    }

    log("jito", `Bundle submitted: ${bundleId} (${signedTxs.length} tx, region=${region})`);
    return bundleId;
  } catch (e) {
    recordCounter("jito_bundle_failed");
    log("jito_error", `sendBundle failed: ${e.message}`);
    throw e;
  }
}

/**
 * Poll bundle status. Returns the array element from getBundleStatuses, or
 * null if not yet processed.
 */
export async function getBundleStatus({ bundleId, region = "fra", authToken = null } = {}) {
  if (!bundleId) throw new Error("getBundleStatus: bundleId required");
  const result = await jitoRpc({
    region,
    method: "getBundleStatuses",
    params: [[bundleId]],
    authToken,
  });
  const value = result?.value;
  if (!Array.isArray(value) || value.length === 0) return null;
  return value[0]; // { bundle_id, transactions, slot, confirmation_status, err }
}

/**
 * Wait for bundle to land (confirmation_status === "confirmed" or "finalized")
 * or fail. Polls every `intervalMs`, gives up after `timeoutMs`.
 */
export async function awaitBundleLanding({
  bundleId,
  region = "fra",
  authToken = null,
  intervalMs = 1000,
  timeoutMs = 30_000,
} = {}) {
  const t0 = startTimer();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getBundleStatus({ bundleId, region, authToken }).catch(() => null);
    if (status?.confirmation_status === "confirmed" || status?.confirmation_status === "finalized") {
      recordLatency("jito_bundle_land_ms", elapsedMs(t0));
      return { landed: true, status };
    }
    if (status?.err) {
      return { landed: false, status };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { landed: false, status: { err: "timeout" } };
}

// ─── Convenience: submit a single tx as a bundle ──────────────────

/**
 * Highest-level helper: takes one already-signed tx (from Jupiter / a custom
 * builder / wherever), wraps it with a tip transaction the agent's wallet
 * signs, and submits the pair as a bundle.
 *
 * Note: the tip tx uses the same blockhash as the main tx by default — Jito
 * requires all bundle members to share a recent enough blockhash. Pass an
 * explicit `recentBlockhash` if your main tx uses a stale one.
 */
export async function submitSwapBundle({
  signedSwapTx,
  wallet,
  recentBlockhash,
  tipLamports,
  region = "fra",
  authToken = null,
} = {}) {
  if (!signedSwapTx) throw new Error("submitSwapBundle: signedSwapTx required");
  if (!wallet?.publicKey) throw new Error("submitSwapBundle: wallet required");
  if (!recentBlockhash) throw new Error("submitSwapBundle: recentBlockhash required");

  const tipTx = buildTipTransaction({ wallet, recentBlockhash, tipLamports });
  const dedupKey = idempotencyKey(signedSwapTx);
  const bundleId = await sendBundle({
    signedTxs: [signedSwapTx, tipTx],
    region,
    authToken,
    idempotencyKey: dedupKey,
  });
  return bundleId;
}

export const _internal = { TIP_ACCOUNTS, REGION_ENDPOINTS };
