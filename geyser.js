/**
 * Geyser stream scaffold — real-time Solana account updates via Helius Atlas
 * WebSocket (or any compatible Yellowstone-style provider).
 *
 * Why: the bot currently learns about smart-wallet activity by polling the
 * DexScreener "smart money inflow" aggregate every screening cycle. That
 * misses the actual buy by minutes. With a Geyser stream, the bot can react
 * within a slot or two of a tracked wallet's swap landing on-chain — the
 * actual missing link for sub-second sniping.
 *
 * Status: scaffold. Implements connection, subscription, parsing, reconnect.
 * NOT wired into the cron loops by default — call startGeyserStream() from
 * index.js once your provider creds are in place. Fail-soft: if the env vars
 * aren't set, the start function logs and returns null (no crash, no noisy
 * retries).
 *
 * Provider options
 *   Helius Atlas (free tier):
 *     HELIUS_ATLAS_WS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=...
 *   Triton Yellowstone (paid gRPC):
 *     would need a different transport — this module is WS-only.
 *
 * Subscription
 *   Right now we subscribe to transactionSubscribe filtered by the list of
 *   smart wallets the user has registered (smart-wallets.js). Add new wallets
 *   live with refreshSubscriptions().
 */

import { log } from "./logger.js";
import { listSmartWallets } from "./smart-wallets.js";
import { recordCounter, setGauge } from "./metrics.js";

// Reconnect schedule (ms) — exponential backoff capped at 30s. Resets on
// successful connect. Conservative because the WS server may rate-limit
// reconnect storms.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

export class GeyserStream {
  /**
   * @param {object} opts
   * @param {string} opts.url            WebSocket URL (with auth in query string)
   * @param {(event:object)=>void} [opts.onEvent]  Called for each parsed event
   * @param {string[]} [opts.accountInclude]       Wallets to filter by
   * @param {string}  [opts.commitment]  "processed" | "confirmed" | "finalized"
   * @param {boolean} [opts.reconnect]   auto-reconnect on close
   */
  constructor({
    url,
    onEvent = () => {},
    onDisconnect = null,
    accountInclude = [],
    commitment = "confirmed",
    reconnect = true,
  }) {
    if (!url) throw new Error("GeyserStream: url required");
    this.url = url;
    this.onEvent = onEvent;
    this.onDisconnect = onDisconnect;
    this.accountInclude = [...accountInclude];
    this.commitment = commitment;
    this.shouldReconnect = reconnect;

    this._ws = null;
    this._reconnectAttempt = 0;
    this._subscriptionId = null;
    this._closed = false;
    this._nextRpcId = 1;
    this._reconnectTimer = null;
    this._subConfirmTimer = null; // subscription confirmation watchdog
  }

  connect() {
    if (this._ws) return;
    log("geyser", `Connecting to ${redactUrl(this.url)}`);
    try {
      this._ws = new WebSocket(this.url);
    } catch (e) {
      log("geyser_error", `WS construct failed: ${e.message}`);
      this._scheduleReconnect();
      return;
    }
    this._ws.addEventListener("open", () => this._onOpen());
    this._ws.addEventListener("message", (e) => this._onMessage(e));
    this._ws.addEventListener("close", () => this._onClose());
    this._ws.addEventListener("error", (e) => this._onError(e));
  }

  /**
   * Update the wallet filter live. Sends a new subscribe — Helius will
   * close the previous one on next connect; for a long-lived stream, prefer
   * close() + reconnect() to flush stale subscriptions cleanly.
   */
  refreshSubscriptions(accountInclude) {
    this.accountInclude = [...accountInclude];
    if (this._ws && this._ws.readyState === 1 /* OPEN */) {
      this._sendSubscribe();
    }
  }

  close() {
    this._closed = true;
    this.shouldReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._subConfirmTimer) {
      clearTimeout(this._subConfirmTimer);
      this._subConfirmTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch { /* no-op */ }
    }
    this._ws = null;
    setGauge("geyser_connected", 0);
  }

  isConnected() {
    return this._ws?.readyState === 1;
  }

  // ─── Internals ──────────────────────────────────────────────

  _onOpen() {
    log("geyser", "Connected");
    this._reconnectAttempt = 0;
    setGauge("geyser_connected", 1);
    recordCounter("geyser_connected_total");
    this._sendSubscribe();
  }

  _sendSubscribe() {
    if (!this._ws || this._ws.readyState !== 1) return;
    if (this.accountInclude.length === 0) {
      log("geyser", "No accounts to subscribe — leaving stream idle");
      return;
    }
    const rpcId = this._nextRpcId++;
    const payload = {
      jsonrpc: "2.0",
      id: rpcId,
      method: "transactionSubscribe",
      params: [
        {
          accountInclude: this.accountInclude,
          vote: false,
          failed: false,
        },
        {
          commitment: this.commitment,
          encoding: "jsonParsed",
          transactionDetails: "full",
          maxSupportedTransactionVersion: 0,
        },
      ],
    };
    this._ws.send(JSON.stringify(payload));
    this._subscriptionId = null; // clear stale id from prior session
    log("geyser", `Subscribed to ${this.accountInclude.length} wallets (commitment=${this.commitment})`);

    // Subscription confirmation watchdog — if the server doesn't confirm
    // within 10s the subscription silently failed (e.g. after a network flap
    // where the WS reconnected but the server dropped the session). Log a
    // warning and force a reconnect so subscriptions are never silently stale.
    if (this._subConfirmTimer) clearTimeout(this._subConfirmTimer);
    this._subConfirmTimer = setTimeout(() => {
      this._subConfirmTimer = null;
      if (this._subscriptionId == null && !this._closed) {
        recordCounter("geyser_sub_confirm_timeout");
        log("geyser_warn", `Subscription not confirmed within 10s — forcing reconnect to recover`);
        try { this._ws?.close(); } catch {}
        this._ws = null;
        this._scheduleReconnect();
      }
    }, 10_000);
  }

  _onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch (e) {
      recordCounter("geyser_parse_error");
      return;
    }

    // Subscription confirmation — clear watchdog timer on success.
    if (msg.result != null && typeof msg.result === "number" && msg.id != null) {
      this._subscriptionId = msg.result;
      if (this._subConfirmTimer) {
        clearTimeout(this._subConfirmTimer);
        this._subConfirmTimer = null;
      }
      log("geyser", `Subscription confirmed (id=${this._subscriptionId})`);
      return;
    }

    // Stream notification — `params.result` holds the transaction event
    if (msg.method === "transactionNotification" && msg.params?.result) {
      recordCounter("geyser_events_total");
      const parsed = parseTransactionEvent(msg.params.result);
      if (parsed) {
        try {
          Promise.resolve(this.onEvent(parsed)).catch((e) => {
            recordCounter("geyser_consumer_error");
            log("geyser_error", `onEvent rejected: ${e.message}`);
          });
        } catch (e) {
          recordCounter("geyser_consumer_error");
          log("geyser_error", `onEvent threw: ${e.message}`);
        }
      }
      return;
    }

    if (msg.error) {
      recordCounter("geyser_server_error");
      log("geyser_error", `Server error: ${JSON.stringify(msg.error)}`);
    }
  }

  _onClose() {
    setGauge("geyser_connected", 0);
    this._ws = null;
    if (!this.shouldReconnect || this._closed) return;
    if (this.onDisconnect) {
      try { this.onDisconnect(this._reconnectAttempt); } catch {}
    }
    this._scheduleReconnect();
  }

  _onError(err) {
    recordCounter("geyser_ws_error");
    log("geyser_error", `WS error: ${err?.message || "(no message)"}`);
    // close handler will fire afterwards and trigger reconnect
  }

  _scheduleReconnect() {
    if (this._closed) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    this._reconnectAttempt++;
    log("geyser", `Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Best-effort parse of a Helius/Yellowstone transactionNotification into a
 * domain event the rest of the codebase can use. Returns null for things we
 * don't recognize so consumers can filter by truthiness.
 *
 * Shape we emit (when SWAP-like):
 *   {
 *     kind: "swap",
 *     signature: string,
 *     slot: number,
 *     wallet: string,         // first account from accountKeys
 *     token_in: string|null,
 *     token_out: string|null,
 *     amount_in: number|null,
 *     amount_out: number|null,
 *     ts: ISO string
 *   }
 */
export function parseTransactionEvent(payload) {
  if (!payload?.transaction) return null;
  const signature = payload.signature || payload.transaction?.signatures?.[0];
  const slot = payload.slot;

  const message = payload.transaction.transaction?.message;
  const accountKeys = message?.accountKeys || [];
  const wallet = typeof accountKeys[0] === "string" ? accountKeys[0] : accountKeys[0]?.pubkey;

  // Pull token balances diff if jsonParsed encoding is in effect — gives us
  // a coarse but reliable "what moved in/out" view without needing to decode
  // DEX-specific instructions.
  const pre = payload.transaction.meta?.preTokenBalances || [];
  const post = payload.transaction.meta?.postTokenBalances || [];
  const { token_in, token_out, amount_in, amount_out } = diffTokenBalances(pre, post, wallet);

  return {
    kind: token_in || token_out ? "swap" : "tx",
    signature,
    slot,
    wallet,
    token_in,
    token_out,
    amount_in,
    amount_out,
    ts: new Date().toISOString(),
  };
}

/**
 * Find which mint decreased and which increased for the target wallet.
 * Returns the most-likely (token_in, token_out, amount_in, amount_out) pair.
 */
export function diffTokenBalances(pre, post, ownerFilter = null) {
  const owns = (b) => !ownerFilter || b.owner === ownerFilter;
  const preMap = new Map(pre.filter(owns).map((b) => [b.mint, Number(b.uiTokenAmount?.uiAmount) || 0]));
  const postMap = new Map(post.filter(owns).map((b) => [b.mint, Number(b.uiTokenAmount?.uiAmount) || 0]));
  let biggestDrop = { mint: null, delta: 0 };
  let biggestGain = { mint: null, delta: 0 };
  const mints = new Set([...preMap.keys(), ...postMap.keys()]);
  for (const mint of mints) {
    const delta = (postMap.get(mint) || 0) - (preMap.get(mint) || 0);
    if (delta < biggestDrop.delta) biggestDrop = { mint, delta };
    if (delta > biggestGain.delta) biggestGain = { mint, delta };
  }
  return {
    token_in: biggestDrop.mint,
    token_out: biggestGain.mint,
    amount_in: biggestDrop.mint ? Math.abs(biggestDrop.delta) : null,
    amount_out: biggestGain.mint ? Math.abs(biggestGain.delta) : null,
  };
}

/**
 * Hide the api-key query param when logging URLs.
 */
function redactUrl(url) {
  try {
    return String(url).replace(/(\?|&)(api-key|apiKey|token)=[^&]*/gi, "$1$2=<redacted>");
  } catch {
    return "<url>";
  }
}

/**
 * Fail-soft factory: returns null when no creds, otherwise starts the stream.
 * Wires the smart-wallets registry as the default account filter.
 */
export function startGeyserStream({ onEvent, onDisconnect = null, commitment = "confirmed" } = {}) {
  const url = process.env.HELIUS_ATLAS_WS_URL || process.env.HELIUS_GEYSER_URL;
  if (!url) {
    // Silent — index.js prints a consolidated "optional features" summary at startup.
    return null;
  }

  let wallets = [];
  try { wallets = listSmartWallets({ minDecayMultiplier: 0.5 }).map((w) => w.address); }
  catch (e) { log("geyser_warn", `listSmartWallets failed: ${e.message}`); }

  const stream = new GeyserStream({
    url,
    onEvent: onEvent || (() => {}),
    onDisconnect,
    accountInclude: wallets,
    commitment,
  });
  stream.connect();
  return stream;
}
