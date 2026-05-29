// Tests for createCachedFetcher — the TTL cache + in-flight de-dup wrapper that
// shaves redundant Helius RPC (applied to getTokenSecurityDetails). Covers:
// cache hit/expiry, concurrent de-dup, error pass-through (not cached), LRU-ish
// eviction, and custom key.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCachedFetcher } from "../cache-util.js";

describe("createCachedFetcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("caches a successful result for ttlMs (one underlying call)", async () => {
    const fn = vi.fn(async (x) => ({ value: x }));
    const cached = createCachedFetcher(fn, { ttlMs: 1000 });

    expect(await cached("a")).toEqual({ value: "a" });
    expect(await cached("a")).toEqual({ value: "a" });
    expect(fn).toHaveBeenCalledTimes(1); // second served from cache
  });

  it("refetches after the TTL expires", async () => {
    const fn = vi.fn(async (x) => ({ value: x }));
    const cached = createCachedFetcher(fn, { ttlMs: 1000 });

    await cached("a");
    vi.advanceTimersByTime(1001);
    await cached("a");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("de-dups concurrent calls for the same key onto one in-flight promise", async () => {
    let resolve;
    const fn = vi.fn(() => new Promise((r) => { resolve = () => r({ value: "x" }); }));
    const cached = createCachedFetcher(fn, { ttlMs: 1000 });

    const p1 = cached("a");
    const p2 = cached("a"); // should attach to the same in-flight promise
    resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ value: "x" });
    expect(r2).toBe(r1); // same resolved object
  });

  it("does NOT cache error results — they retry next call", async () => {
    const fn = vi.fn(async (x) => ({ mint: x, error: "rpc 429" }));
    const cached = createCachedFetcher(fn, { ttlMs: 1000 });

    await cached("a");
    await cached("a");
    expect(fn).toHaveBeenCalledTimes(2); // error not cached → refetched
  });

  it("clears the in-flight entry after settle so later calls refetch post-TTL", async () => {
    const fn = vi.fn(async (x) => ({ value: x }));
    const cached = createCachedFetcher(fn, { ttlMs: 1000 });

    await cached("a");            // cached
    vi.advanceTimersByTime(1001); // expire
    await cached("a");            // refetch — would hang if inflight wasn't cleared
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry when over max", async () => {
    const fn = vi.fn(async (x) => ({ value: x }));
    const cached = createCachedFetcher(fn, { ttlMs: 100_000, max: 2 });

    await cached("a");
    vi.advanceTimersByTime(1);
    await cached("b");
    vi.advanceTimersByTime(1);
    await cached("c"); // over max(2) → "a" (oldest) evicted

    await cached("b"); // still cached
    await cached("c"); // still cached
    expect(fn).toHaveBeenCalledTimes(3); // b, c served from cache
    await cached("a"); // evicted → refetch
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("uses a custom key extractor (object args keyed by mint)", async () => {
    const fn = vi.fn(async ({ mint }) => ({ mint }));
    const cached = createCachedFetcher(fn, { ttlMs: 1000, key: ({ mint } = {}) => mint || "" });

    await cached({ mint: "M1", extra: 1 });
    await cached({ mint: "M1", extra: 999 }); // different extra, same mint → cache hit
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("_reset clears cache and in-flight state", async () => {
    const fn = vi.fn(async (x) => ({ value: x }));
    const cached = createCachedFetcher(fn, { ttlMs: 100_000 });

    await cached("a");
    cached._reset();
    await cached("a");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
