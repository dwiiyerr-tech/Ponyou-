export const ALLOWED_METHODS = Object.freeze([
  "getLatestBlockhash",
  "getRecentPrioritizationFees",
  "getPriorityFeeEstimate",
  "simulateTransaction",
  "getAccountInfo",
  "getBalance",
]);

export class RpcQuorumError extends Error {
  constructor({ method, endpoint_errors }) {
    super(`RPC quorum failed for ${method}: all endpoints errored`);
    this.method = method;
    this.endpoint_errors = endpoint_errors;
    this.name = "RpcQuorumError";
  }
}

export function createRpcQuorum({ endpoints, timeoutMs = 2000, connectionFactory = null, log = () => {} } = {}) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new Error("rpc-quorum: endpoints array required");
  }
  const conns = connectionFactory ? connectionFactory(endpoints) : endpoints.map(e => ({
    url: e.url,
    label: e.label,
    primary: e.primary || false,
    call: async (method) => { throw new Error(`real RPC client not wired (method=${method})`); },
  }));
  // Propagate primary flag from endpoints config into conn objects (connectionFactory may not set it).
  const primaryUrls = new Set(endpoints.filter(e => e.primary).map(e => e.url));
  for (const c of conns) if (primaryUrls.has(c.url)) c.primary = true;
  const health = new Map(conns.map(c => [c.url, { successCount: 0, failCount: 0, lastError: null, lastLatencyMs: null, cooldownUntil: 0 }]));

  async function quorumCall(method, ...args) {
    if (!ALLOWED_METHODS.includes(method)) {
      throw new Error(`rpc-quorum: method "${method}" not allowed (whitelist only)`);
    }
    const now = Date.now();
    const active = conns.filter(c => health.get(c.url).cooldownUntil <= now);
    const targets = active.length > 0 ? active : conns;

    // If a primary endpoint exists and is healthy, try it first before racing others.
    const primary = targets.find(c => c.primary);
    if (primary) {
      try {
        const start = Date.now();
        const result = await primary.call(method, ...args);
        const h = health.get(primary.url);
        h.successCount += 1;
        h.lastLatencyMs = Date.now() - start;
        return result;
      } catch (err) {
        const h = health.get(primary.url);
        h.failCount += 1;
        h.lastError = err.message;
      }
    }

    const fallbacks = primary ? targets.filter(c => !c.primary) : targets;
    const errors = [];
    return new Promise((resolve, reject) => {
      let pending = fallbacks.length;
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new RpcQuorumError({ method, endpoint_errors: errors.length ? errors : [{ url: "timeout", error: "global timeout" }] }));
        }
      }, timeoutMs);
      fallbacks.forEach(c => {
        const start = Date.now();
        c.call(method, ...args)
          .then(result => {
            const elapsed = Date.now() - start;
            const h = health.get(c.url);
            h.successCount += 1;
            h.lastLatencyMs = elapsed;
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve(result);
            }
          })
          .catch(err => {
            const h = health.get(c.url);
            h.failCount += 1;
            h.lastError = err.message;
            const total = h.successCount + h.failCount;
            if (total >= 10 && h.successCount / total < 0.5) {
              h.cooldownUntil = Date.now() + 60_000;
            }
            errors.push({ url: c.url, error: err.message });
            pending -= 1;
            if (pending === 0 && !resolved) {
              resolved = true;
              clearTimeout(timeout);
              reject(new RpcQuorumError({ method, endpoint_errors: errors }));
            }
          });
      });
    });
  }

  function healthSnapshot() {
    const out = {};
    for (const [url, h] of health.entries()) out[url] = { ...h };
    return out;
  }

  function shutdown() {
    health.clear();
  }

  return { quorumCall, healthSnapshot, shutdown };
}
