export const ALLOWED_METHODS = Object.freeze([
  "getLatestBlockhash",
  "getRecentPrioritizationFees",
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
    call: async (method) => { throw new Error(`real RPC client not wired (method=${method})`); },
  }));
  const health = new Map(conns.map(c => [c.url, { successCount: 0, failCount: 0, lastError: null, lastLatencyMs: null, cooldownUntil: 0 }]));

  async function quorumCall(method, ...args) {
    if (!ALLOWED_METHODS.includes(method)) {
      throw new Error(`rpc-quorum: method "${method}" not allowed (whitelist only)`);
    }
    const now = Date.now();
    const active = conns.filter(c => health.get(c.url).cooldownUntil <= now);
    const targets = active.length > 0 ? active : conns;
    const errors = [];
    return new Promise((resolve, reject) => {
      let pending = targets.length;
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new RpcQuorumError({ method, endpoint_errors: errors.length ? errors : [{ url: "timeout", error: "global timeout" }] }));
        }
      }, timeoutMs);
      targets.forEach(c => {
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
