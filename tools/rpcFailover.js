/** RPC endpoint failover with latency-based selection and circuit breaker. */

const CircuitState = Object.freeze({ CLOSED: "CLOSED", OPEN: "OPEN", PAUSED: "PAUSED" });

export class RpcFailover {
  constructor({ endpoints }) {
    this._endpoints = endpoints.map((e) => ({
      url: typeof e === "string" ? e : e.url,
      name: typeof e === "string" ? e : (e.name || e.url),
      latencyMs: Infinity,
      failures: 0,
      healthy: true,
    }));
    this._circuitState = CircuitState.CLOSED;
    this._healthInterval = null;
  }

  /** Returns best available endpoint object ({ url, name }). Throws if circuit PAUSED. */
  getEndpoint() {
    if (this._circuitState === CircuitState.PAUSED) {
      throw new Error("RpcFailover: circuit PAUSED — all endpoints unhealthy");
    }
    const available = this._endpoints.filter((e) => e.healthy);
    if (!available.length) {
      this._circuitState = CircuitState.PAUSED;
      throw new Error("RpcFailover: circuit PAUSED — all endpoints unhealthy");
    }
    const sorted = [...available].sort((a, b) => a.latencyMs - b.latencyMs);
    return sorted[0];
  }

  /** Pings all endpoints, updates latency and health. */
  async checkHealth() {
    const results = await Promise.allSettled(
      this._endpoints.map(async (ep) => {
        const start = Date.now();
        const res = await fetch(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ep.latencyMs = Date.now() - start;
        ep.failures = 0;
        ep.healthy = true;
      })
    );

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        this._endpoints[i].failures += 1;
        this._endpoints[i].healthy = this._endpoints[i].failures < 3;
        if (this._endpoints[i].failures === 1) {
          this._endpoints[i].latencyMs = Infinity;
        }
      }
    });

    const anyHealthy = this._endpoints.some((e) => e.healthy);
    this._circuitState = anyHealthy ? CircuitState.CLOSED : CircuitState.PAUSED;
    return this._endpoints.map(({ url, name, latencyMs, healthy, failures }) => ({
      url, name, latencyMs, healthy, failures,
    }));
  }

  /** Start background health checks every intervalMs (default 60s). */
  startHealthLoop(intervalMs = 60_000) {
    if (this._healthInterval) return;
    this._healthInterval = setInterval(() => this.checkHealth().catch(() => {}), intervalMs);
    this.checkHealth().catch(() => {});
  }

  stopHealthLoop() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
  }

  get circuitState() { return this._circuitState; }
}

/** Factory: create RpcFailover from array of URL strings or endpoint objects. */
export function createRpcFailover(endpoints) {
  return new RpcFailover({ endpoints });
}
