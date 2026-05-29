import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  throttleConnection,
  rpcCircuitOpen,
  __rpcLimiterStats,
  __resetRpcLimiter,
} from "../tools/solana-rpc.js";

// A fake Connection exposing the methods the limiter knows about, plus a
// non-throttled method and a sync property, so we can assert the proxy only
// gates the networked calls.
function makeFakeConnection({ onCall } = {}) {
  let inflight = 0;
  let maxObserved = 0;
  const conn = {
    rpcEndpoint: "https://fake.helius",
    async getParsedAccountInfo(mint) {
      inflight++;
      maxObserved = Math.max(maxObserved, inflight);
      onCall?.(mint);
      await new Promise(r => setTimeout(r, 5));
      inflight--;
      return { value: { mint } };
    },
    async getTokenLargestAccounts() {
      return { value: [] };
    },
    // Not in the throttle allowlist — must pass through untouched & sync-return.
    onAccountChange() {
      return 42;
    },
  };
  return { conn, stats: () => ({ maxObserved }) };
}

describe("raw RPC rate limiter", () => {
  beforeEach(() => __resetRpcLimiter());

  it("caps concurrency at RPC_MAX_CONCURRENT (default 3)", async () => {
    const { conn, stats } = makeFakeConnection();
    const c = throttleConnection(conn);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => c.getParsedAccountInfo(`m${i}`))
    );
    expect(stats().maxObserved).toBeLessThanOrEqual(3);
  });

  it("passes non-throttled methods through synchronously", () => {
    const { conn } = makeFakeConnection();
    const c = throttleConnection(conn);
    expect(c.onAccountChange()).toBe(42); // not a Promise
    expect(c.rpcEndpoint).toBe("https://fake.helius"); // property untouched
  });

  it("spaces calls by RPC_MIN_INTERVAL_MS", async () => {
    const times = [];
    const { conn } = makeFakeConnection({ onCall: () => times.push(Date.now()) });
    const c = throttleConnection(conn);
    await Promise.all(
      Array.from({ length: 4 }, (_, i) => c.getParsedAccountInfo(`m${i}`))
    );
    times.sort((a, b) => a - b);
    // With default 120ms spacing the 4th call starts >= ~300ms after the first.
    expect(times[times.length - 1] - times[0]).toBeGreaterThanOrEqual(250);
  });

  it("opens the circuit after consecutive 429s, then sheds load fast", async () => {
    const conn = {
      async getParsedAccountInfo() {
        const e = new Error("Server responded with 429 Too Many Requests");
        throw e;
      },
    };
    const c = throttleConnection(conn);
    // Default threshold is 5 consecutive 429s.
    for (let i = 0; i < 5; i++) {
      await expect(c.getParsedAccountInfo("m")).rejects.toThrow(/429/);
    }
    expect(rpcCircuitOpen()).toBe(true);
    // Once open, further calls reject immediately without hitting the endpoint.
    await expect(c.getParsedAccountInfo("m")).rejects.toThrow(/circuit open/);
  });

  it("resets the 429 streak on a success", async () => {
    let fail = true;
    const conn = {
      async getParsedAccountInfo() {
        if (fail) throw new Error("429");
        return { ok: true };
      },
    };
    const c = throttleConnection(conn);
    await expect(c.getParsedAccountInfo("m")).rejects.toThrow(/429/);
    await expect(c.getParsedAccountInfo("m")).rejects.toThrow(/429/);
    expect(__rpcLimiterStats().streak).toBe(2);
    fail = false;
    await c.getParsedAccountInfo("m");
    expect(__rpcLimiterStats().streak).toBe(0);
    expect(rpcCircuitOpen()).toBe(false);
  });

  it("releases the in-flight slot even when the call throws", async () => {
    const conn = {
      async getParsedAccountInfo() {
        throw new Error("boom");
      },
    };
    const c = throttleConnection(conn);
    await expect(c.getParsedAccountInfo("m")).rejects.toThrow(/boom/);
    expect(__rpcLimiterStats().inflight).toBe(0);
    expect(__rpcLimiterStats().queued).toBe(0);
  });
});
