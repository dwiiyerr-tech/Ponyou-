/**
 * createCachedFetcher — wrap an async fetch with a TTL result cache + in-flight
 * de-duplication. Built to shave redundant Helius RPC calls: the heaviest
 * consumers (e.g. getTokenSecurityDetails) are invoked for the same mint across
 * the screening, management, and enrichment paths within the same window.
 *
 *   - TTL cache: a successful result is reused for `ttlMs`. Security/holder
 *     data is slow-moving, so a few minutes of staleness is acceptable and
 *     collapses N calls/window into 1.
 *   - In-flight de-dup: concurrent callers for the same key await the SAME
 *     promise instead of each firing its own RPC burst.
 *   - Errors are NOT cached (transient RPC/429 failures must retry next call;
 *     the upstream Helius circuit breaker handles sustained outages).
 *
 * @param {Function} fetchFn          the underlying async fetch
 * @param {object}   opts
 * @param {number}   opts.ttlMs        cache lifetime for successful results
 * @param {number}   [opts.max=500]    hard cap on cache entries (drops oldest)
 * @param {Function} [opts.key]        args → cache key (default: JSON of args)
 * @param {Function} [opts.isError]    result → boolean "don't cache" (default: truthy .error)
 * @returns {Function} wrapped fetcher with a `_reset()` test hook
 */
export function createCachedFetcher(fetchFn, {
  ttlMs,
  max = 500,
  key = (...args) => JSON.stringify(args),
  isError = (r) => Boolean(r && r.error),
} = {}) {
  const cache = new Map();      // key → { ts, data }
  const inflight = new Map();   // key → Promise

  const wrapped = async (...args) => {
    const k = key(...args);

    const hit = cache.get(k);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.data;

    // Coalesce concurrent callers onto one in-flight request.
    const flying = inflight.get(k);
    if (flying) return flying;

    const p = (async () => {
      const data = await fetchFn(...args);
      if (!isError(data)) {
        cache.set(k, { ts: Date.now(), data });
        if (cache.size > max) {
          let oldestKey = null;
          let oldestTs = Infinity;
          for (const [ck, cv] of cache) {
            if (cv.ts < oldestTs) { oldestTs = cv.ts; oldestKey = ck; }
          }
          if (oldestKey !== null) cache.delete(oldestKey);
        }
      }
      return data;
    })();

    inflight.set(k, p);
    try {
      return await p;
    } finally {
      inflight.delete(k);
    }
  };

  wrapped._reset = () => { cache.clear(); inflight.clear(); };
  return wrapped;
}
