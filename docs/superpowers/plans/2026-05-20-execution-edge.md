# Execution Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliable Solana swap landing via Jito bundles with adaptive retry, pre-send simulation, and multi-RPC redundancy.

**Architecture:** 4 new modular files (fee-oracle, rpc-quorum, tx-simulator, jito-executor) composed in `tools/jupiter.js`. Each module is single-responsibility with isolated tests. Singletons initialized at app startup in `index.js`.

**Tech Stack:** Node.js ESM, vitest, `@solana/web3.js`, existing `tools/jito.js`, existing Jupiter v6.

**File map:**
- CREATE: `tools/rpc-quorum.js` — multi-RPC race client (read methods only)
- CREATE: `tools/fee-oracle.js` — periodic mempool sampler, tip + priority fee oracle
- CREATE: `tools/tx-simulator.js` — `simulatePreflight` with error classification
- CREATE: `tools/jito-executor.js` — `submitWithAdaptiveRetry` orchestrator
- CREATE: 5 test files mirroring above + 1 integration test
- MODIFY: `config.js` — add `buildExecutionEdgeConfig` helper + wire
- MODIFY: `user-config.json` — add `executionEdge` block + `jitoEnabled: true`
- MODIFY: `tools/jupiter.js` — `swapToken` uses `submitWithAdaptiveRetry` when `executionEdge.enabled`
- MODIFY: `index.js` — init + expose singletons; shutdown on SIGTERM

---

## Task 1: Config schema + defaults

**Files:**
- Modify: `config.js`
- Modify: `user-config.json`
- Create: `tests/execution-edge-config.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/execution-edge-config.test.js`:
```js
import { describe, expect, it } from "vitest";
import { buildExecutionEdgeConfig } from "../config.js";

describe("buildExecutionEdgeConfig", () => {
  it("provides safe defaults when block missing", () => {
    const r = buildExecutionEdgeConfig({});
    expect(r.enabled).toBe(true);
    expect(r.rpcEndpoints).toHaveLength(2);
    expect(r.rpcEndpoints[0].url).toBe("https://api.mainnet-beta.solana.com");
    expect(r.feeOracle.sampleIntervalMs).toBe(10000);
    expect(r.feeOracle.maxTipLamports).toBe(5_000_000);
    expect(r.feeOracle.baseTipLamports).toBe(100_000);
    expect(r.executor.maxAttempts).toBe(5);
    expect(r.executor.attemptTimeoutMs).toBe(3000);
    expect(r.executor.defaultCuLimit).toBe(200_000);
    expect(r.executor.maxCuLimit).toBe(1_400_000);
  });

  it("respects user overrides keeping unspecified defaults", () => {
    const r = buildExecutionEdgeConfig({ executionEdge: { enabled: false, executor: { maxAttempts: 3 } } });
    expect(r.enabled).toBe(false);
    expect(r.executor.maxAttempts).toBe(3);
    expect(r.executor.attemptTimeoutMs).toBe(3000);
  });

  it("merges custom RPC endpoints", () => {
    const r = buildExecutionEdgeConfig({ executionEdge: { rpcEndpoints: [{ url: "https://helius.io", label: "helius" }] } });
    expect(r.rpcEndpoints).toEqual([{ url: "https://helius.io", label: "helius" }]);
  });
});
```

- [ ] **Step 2: Run test → FAIL**

`npx vitest run tests/execution-edge-config.test.js` → expect `buildExecutionEdgeConfig is not exported`.

- [ ] **Step 3: Add helper to `config.js`**

Insert near `buildRugMonitorConfig` (added earlier):
```js
export function buildExecutionEdgeConfig(u = {}) {
  const ee = u.executionEdge || {};
  return {
    enabled: ee.enabled ?? true,
    rpcEndpoints: Array.isArray(ee.rpcEndpoints) && ee.rpcEndpoints.length > 0
      ? ee.rpcEndpoints
      : [
          { url: "https://api.mainnet-beta.solana.com", label: "solana-public" },
          { url: "https://solana-api.projectserum.com", label: "serum" },
        ],
    feeOracle: {
      sampleIntervalMs: Number.isFinite(ee.feeOracle?.sampleIntervalMs) ? ee.feeOracle.sampleIntervalMs : 10000,
      cacheStaleMs: Number.isFinite(ee.feeOracle?.cacheStaleMs) ? ee.feeOracle.cacheStaleMs : 15000,
      maxTipLamports: Number.isFinite(ee.feeOracle?.maxTipLamports) ? ee.feeOracle.maxTipLamports : 5_000_000,
      maxPriorityFeeMicroLamports: Number.isFinite(ee.feeOracle?.maxPriorityFeeMicroLamports) ? ee.feeOracle.maxPriorityFeeMicroLamports : 10_000_000,
      baseTipLamports: Number.isFinite(ee.feeOracle?.baseTipLamports) ? ee.feeOracle.baseTipLamports : 100_000,
    },
    executor: {
      maxAttempts: Number.isFinite(ee.executor?.maxAttempts) ? ee.executor.maxAttempts : 5,
      attemptTimeoutMs: Number.isFinite(ee.executor?.attemptTimeoutMs) ? ee.executor.attemptTimeoutMs : 3000,
      defaultCuLimit: Number.isFinite(ee.executor?.defaultCuLimit) ? ee.executor.defaultCuLimit : 200_000,
      maxCuLimit: Number.isFinite(ee.executor?.maxCuLimit) ? ee.executor.maxCuLimit : 1_400_000,
      rpcCallTimeoutMs: Number.isFinite(ee.executor?.rpcCallTimeoutMs) ? ee.executor.rpcCallTimeoutMs : 2000,
    },
  };
}
```

Wire into the singleton `config` object: add `executionEdge: buildExecutionEdgeConfig(u),` alongside `rugMonitor: buildRugMonitorConfig(u),`.

- [ ] **Step 4: Add `executionEdge` block to `user-config.json`**

Add this top-level key (preserve existing keys):
```json
"jitoEnabled": true,
"executionEdge": {
  "enabled": true,
  "rpcEndpoints": [
    { "url": "https://api.mainnet-beta.solana.com", "label": "solana-public" },
    { "url": "https://solana-api.projectserum.com", "label": "serum" }
  ],
  "feeOracle": {
    "sampleIntervalMs": 10000,
    "cacheStaleMs": 15000,
    "maxTipLamports": 5000000,
    "maxPriorityFeeMicroLamports": 10000000,
    "baseTipLamports": 100000
  },
  "executor": {
    "maxAttempts": 5,
    "attemptTimeoutMs": 3000,
    "defaultCuLimit": 200000,
    "maxCuLimit": 1400000,
    "rpcCallTimeoutMs": 2000
  }
}
```

- [ ] **Step 5: Run targeted + full suite**

`npx vitest run tests/execution-edge-config.test.js` → 3 pass.
`npx vitest run 2>&1 | tail -3` → no regression.

- [ ] **Step 6: Commit**

```bash
git add config.js user-config.json tests/execution-edge-config.test.js
git commit -m "feat(exec-edge): config schema + defaults + jitoEnabled flip"
```

---

## Task 2: rpc-quorum.js — multi-RPC race client

**Files:**
- Create: `tools/rpc-quorum.js`
- Create: `tests/rpc-quorum.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/rpc-quorum.test.js`:
```js
import { describe, expect, it, vi } from "vitest";
import { createRpcQuorum, RpcQuorumError, ALLOWED_METHODS } from "../tools/rpc-quorum.js";

describe("rpc-quorum", () => {
  const endpoints = [
    { url: "https://a.example", label: "a" },
    { url: "https://b.example", label: "b" },
  ];

  function makeMockConn({ delays = [50, 100], errors = [null, null] } = {}) {
    return endpoints.map((e, i) => ({
      url: e.url,
      label: e.label,
      call: vi.fn(async () => {
        await new Promise(r => setTimeout(r, delays[i]));
        if (errors[i]) throw errors[i];
        return { from: e.label };
      }),
    }));
  }

  it("returns first success and aborts slower endpoints", async () => {
    const conns = makeMockConn({ delays: [10, 100] });
    const rq = createRpcQuorum({ endpoints, timeoutMs: 500, connectionFactory: () => conns });
    const result = await rq.quorumCall("getLatestBlockhash");
    expect(result.from).toBe("a");
    rq.shutdown();
  });

  it("falls through to next when first errors", async () => {
    const conns = makeMockConn({ delays: [10, 50], errors: [new Error("fail"), null] });
    const rq = createRpcQuorum({ endpoints, timeoutMs: 500, connectionFactory: () => conns });
    const result = await rq.quorumCall("getLatestBlockhash");
    expect(result.from).toBe("b");
    rq.shutdown();
  });

  it("throws RpcQuorumError when all endpoints fail", async () => {
    const conns = makeMockConn({ delays: [10, 10], errors: [new Error("e1"), new Error("e2")] });
    const rq = createRpcQuorum({ endpoints, timeoutMs: 500, connectionFactory: () => conns });
    await expect(rq.quorumCall("getLatestBlockhash")).rejects.toThrow(RpcQuorumError);
    rq.shutdown();
  });

  it("blocks non-whitelisted methods", async () => {
    const conns = makeMockConn();
    const rq = createRpcQuorum({ endpoints, timeoutMs: 500, connectionFactory: () => conns });
    await expect(rq.quorumCall("sendTransaction")).rejects.toThrow(/not allowed/i);
    rq.shutdown();
  });

  it("exposes ALLOWED_METHODS whitelist", () => {
    expect(ALLOWED_METHODS).toContain("getLatestBlockhash");
    expect(ALLOWED_METHODS).toContain("getRecentPrioritizationFees");
    expect(ALLOWED_METHODS).toContain("simulateTransaction");
    expect(ALLOWED_METHODS).not.toContain("sendTransaction");
  });

  it("tracks health snapshot per endpoint", async () => {
    const conns = makeMockConn({ delays: [10, 100] });
    const rq = createRpcQuorum({ endpoints, timeoutMs: 500, connectionFactory: () => conns });
    await rq.quorumCall("getLatestBlockhash");
    const snap = rq.healthSnapshot();
    expect(snap["https://a.example"]).toBeDefined();
    expect(snap["https://a.example"].successCount).toBe(1);
    rq.shutdown();
  });

  it("throws at construction with empty endpoints", () => {
    expect(() => createRpcQuorum({ endpoints: [], timeoutMs: 500 })).toThrow(/endpoints/i);
  });
});
```

- [ ] **Step 2: Run → FAIL**

`npx vitest run tests/rpc-quorum.test.js` → `Cannot find module '../tools/rpc-quorum.js'`.

- [ ] **Step 3: Create `tools/rpc-quorum.js`**

```js
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
    call: async (method, ...args) => { throw new Error(`real RPC client not wired (method=${method})`); },
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
```

- [ ] **Step 4: Run → PASS**

`npx vitest run tests/rpc-quorum.test.js` → 7 pass.

- [ ] **Step 5: Full suite no regression**

`npx vitest run 2>&1 | tail -3` → all pass.

- [ ] **Step 6: Commit**

```bash
git add tools/rpc-quorum.js tests/rpc-quorum.test.js
git commit -m "feat(exec-edge): rpc-quorum multi-RPC race client with health tracking"
```

---

## Task 3: fee-oracle.js — adaptive tip + priority fee oracle

**Files:**
- Create: `tools/fee-oracle.js`
- Create: `tests/fee-oracle.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/fee-oracle.test.js`:
```js
import { describe, expect, it, vi } from "vitest";
import { createFeeOracle } from "../tools/fee-oracle.js";

const defaultConfig = {
  feeOracle: {
    sampleIntervalMs: 10000,
    cacheStaleMs: 15000,
    maxTipLamports: 5_000_000,
    maxPriorityFeeMicroLamports: 10_000_000,
    baseTipLamports: 100_000,
  },
};

function makeRpcQuorum(feeSamples) {
  return {
    quorumCall: vi.fn(async (method) => {
      if (method === "getRecentPrioritizationFees") {
        return feeSamples.map(f => ({ prioritizationFee: f }));
      }
      throw new Error("unsupported in test");
    }),
  };
}

describe("fee-oracle", () => {
  it("returns baseTip when refreshed with no congestion (low fees)", async () => {
    const rq = makeRpcQuorum([1000, 1000, 1000, 1000]);
    const fo = createFeeOracle({ rpcQuorum: rq, config: defaultConfig });
    await fo.refresh();
    expect(fo.getTip("normal")).toBe(100_000);
    expect(fo.getTip("urgent")).toBe(200_000);
    expect(fo.getTip("critical")).toBe(400_000);
    fo.stop();
  });

  it("scales tip with congestion factor (high fees)", async () => {
    const rq = makeRpcQuorum([200_000, 200_000, 200_000, 200_000]);
    const fo = createFeeOracle({ rpcQuorum: rq, config: defaultConfig });
    await fo.refresh();
    // p75 = 200_000; congestion_factor = clamp(200_000 / 50_000, 1, 5) = 4
    expect(fo.getTip("normal")).toBe(400_000);    // 100_000 * 1 * 4
    expect(fo.getTip("urgent")).toBe(800_000);    // 100_000 * 2 * 4
    expect(fo.getTip("critical")).toBe(1_600_000);// 100_000 * 4 * 4
    fo.stop();
  });

  it("caps tip at maxTipLamports", async () => {
    const rq = makeRpcQuorum([10_000_000, 10_000_000, 10_000_000, 10_000_000]);
    const fo = createFeeOracle({ rpcQuorum: rq, config: defaultConfig });
    await fo.refresh();
    expect(fo.getTip("critical")).toBe(5_000_000);
    fo.stop();
  });

  it("returns p75 priority fee micro-lamports capped", async () => {
    const rq = makeRpcQuorum([100, 200, 300, 400]);
    const fo = createFeeOracle({ rpcQuorum: rq, config: defaultConfig });
    await fo.refresh();
    expect(fo.getPriorityFeeMicroLamports(75)).toBe(300);
    fo.stop();
  });

  it("caps priority fee at max", async () => {
    const rq = makeRpcQuorum([20_000_000, 20_000_000, 20_000_000, 20_000_000]);
    const fo = createFeeOracle({ rpcQuorum: rq, config: defaultConfig });
    await fo.refresh();
    expect(fo.getPriorityFeeMicroLamports(75)).toBe(10_000_000);
    fo.stop();
  });

  it("serves cache within cacheStaleMs", async () => {
    const rq = makeRpcQuorum([1000]);
    const fo = createFeeOracle({ rpcQuorum: rq, config: defaultConfig });
    await fo.refresh();
    expect(rq.quorumCall).toHaveBeenCalledTimes(1);
    fo.getTip("urgent"); // should hit cache
    expect(rq.quorumCall).toHaveBeenCalledTimes(1);
    fo.stop();
  });

  it("getMempoolSnapshot returns p50/p75/p95 + ts", async () => {
    const rq = makeRpcQuorum([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    const fo = createFeeOracle({ rpcQuorum: rq, config: defaultConfig });
    await fo.refresh();
    const snap = fo.getMempoolSnapshot();
    expect(snap.fee_p50).toBeGreaterThan(0);
    expect(snap.fee_p75).toBeGreaterThan(snap.fee_p50);
    expect(snap.fee_p95).toBeGreaterThan(snap.fee_p75);
    expect(snap.sampled_at).toBeGreaterThan(0);
    fo.stop();
  });

  it("returns baseTip when no sample exists yet", () => {
    const rq = makeRpcQuorum([]);
    const fo = createFeeOracle({ rpcQuorum: rq, config: defaultConfig });
    expect(fo.getTip("urgent")).toBe(200_000); // base * 2
    fo.stop();
  });
});
```

- [ ] **Step 2: Run → FAIL**

`npx vitest run tests/fee-oracle.test.js` → module not found.

- [ ] **Step 3: Create `tools/fee-oracle.js`**

```js
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

export function createFeeOracle({ rpcQuorum, config, log = () => {} }) {
  const cfg = config.feeOracle || config.executionEdge?.feeOracle || config;
  let cache = null; // { samples, sampled_at }
  let timer = null;
  let started = false;

  async function refresh() {
    try {
      const result = await rpcQuorum.quorumCall("getRecentPrioritizationFees");
      const fees = (result || []).map(f => f.prioritizationFee).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
      cache = { samples: fees, sampled_at: Date.now() };
    } catch (e) {
      log("fee_oracle", `sample failed: ${e.message}`);
      // keep stale cache up to 60s; else fall back at read time
    }
  }

  function _getSamples() {
    if (!cache) return [];
    return cache.samples;
  }

  function getPriorityFeeMicroLamports(p = 75) {
    const s = _getSamples();
    const v = percentile(s, p);
    return Math.min(v, cfg.maxPriorityFeeMicroLamports);
  }

  function getTip(urgency = "normal") {
    const base = cfg.baseTipLamports;
    const mult = { normal: 1, urgent: 2, critical: 4 }[urgency] || 1;
    const p75 = getPriorityFeeMicroLamports(75);
    const congestion = Math.max(1, Math.min(5, p75 / 50_000));
    const tip = Math.floor(base * mult * congestion);
    return Math.min(tip, cfg.maxTipLamports);
  }

  function getMempoolSnapshot() {
    const s = _getSamples();
    return {
      fee_p50: percentile(s, 50),
      fee_p75: percentile(s, 75),
      fee_p95: percentile(s, 95),
      sampled_at: cache?.sampled_at || 0,
      tip_recommendation: { normal: getTip("normal"), urgent: getTip("urgent"), critical: getTip("critical") },
    };
  }

  function start() {
    if (started) return;
    started = true;
    refresh();
    timer = setInterval(refresh, cfg.sampleIntervalMs);
  }

  function stop() {
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { getPriorityFeeMicroLamports, getTip, getMempoolSnapshot, refresh, start, stop };
}
```

- [ ] **Step 4: Run → PASS**

`npx vitest run tests/fee-oracle.test.js` → 8 pass.

- [ ] **Step 5: Full suite no regression**

- [ ] **Step 6: Commit**

```bash
git add tools/fee-oracle.js tests/fee-oracle.test.js
git commit -m "feat(exec-edge): fee-oracle with adaptive tip + congestion factor"
```

---

## Task 4: tx-simulator.js — preflight error classification

**Files:**
- Create: `tools/tx-simulator.js`
- Create: `tests/tx-simulator.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/tx-simulator.test.js`:
```js
import { describe, expect, it, vi } from "vitest";
import { simulatePreflight, classifySimulationError } from "../tools/tx-simulator.js";

describe("classifySimulationError", () => {
  it("proceeds on success (no err)", () => {
    const r = classifySimulationError({ err: null, logs: [] });
    expect(r.action).toBe("proceed");
  });
  it("blocks on insufficient funds", () => {
    const r = classifySimulationError({ err: "InsufficientFundsForRent", logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("insufficient_balance");
  });
  it("blocks on slippage exceeded (Jupiter custom 6001)", () => {
    const r = classifySimulationError({ err: { InstructionError: [0, { Custom: 6001 }] }, logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("slippage_exceeded");
  });
  it("blocks on ExceededSlippage err string", () => {
    const r = classifySimulationError({ err: "ExceededSlippage", logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("slippage_exceeded");
  });
  it("blocks on AccountNotFound (honeypot)", () => {
    const r = classifySimulationError({ err: "AccountNotFound", logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("honeypot_account_missing");
  });
  it("blocks on InvalidAccountData in token program", () => {
    const r = classifySimulationError({ err: "InvalidAccountData", logs: ["Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke", "InvalidAccountData"] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("honeypot_invalid_account");
  });
  it("bump_cu on ComputeBudgetExceeded", () => {
    const r = classifySimulationError({ err: "ComputeBudgetExceeded", logs: [] });
    expect(r.action).toBe("bump_cu");
    expect(r.reason).toBe("needs_more_cu");
  });
  it("retry on stale blockhash", () => {
    const r = classifySimulationError({ err: "BlockhashNotFound", logs: [] });
    expect(r.action).toBe("retry");
    expect(r.reason).toBe("stale_blockhash");
  });
  it("retry on sim timeout (network)", () => {
    const r = classifySimulationError({ err: "__timeout__", logs: [] });
    expect(r.action).toBe("retry");
    expect(r.reason).toBe("sim_timeout");
  });
  it("blocks on unknown error (fail-closed)", () => {
    const r = classifySimulationError({ err: "WeirdMysteriousError", logs: [] });
    expect(r.action).toBe("block");
    expect(r.reason).toBe("unknown_sim_error");
  });
});

describe("simulatePreflight integration", () => {
  it("returns proceed when sim succeeds", async () => {
    const rpcQuorum = { quorumCall: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }) };
    const res = await simulatePreflight({ tx: {}, rpcQuorum });
    expect(res.ok).toBe(true);
    expect(res.action).toBe("proceed");
  });
});
```

- [ ] **Step 2: Run → FAIL**

`npx vitest run tests/tx-simulator.test.js` → module not found.

- [ ] **Step 3: Create `tools/tx-simulator.js`**

```js
export function classifySimulationError({ err, logs = [] }) {
  if (err === null || err === undefined) return { ok: true, action: "proceed", reason: "clean" };
  const errStr = typeof err === "string" ? err : JSON.stringify(err);
  const logsStr = (logs || []).join("\n");

  if (/InsufficientFunds/i.test(errStr)) return { ok: false, action: "block", reason: "insufficient_balance" };
  if (/Custom.*6001|ExceededSlippage/i.test(errStr)) return { ok: false, action: "block", reason: "slippage_exceeded" };
  if (/AccountNotFound/i.test(errStr)) return { ok: false, action: "block", reason: "honeypot_account_missing" };
  if (/InvalidAccountData/i.test(errStr) && /Token(keg)?/.test(logsStr)) return { ok: false, action: "block", reason: "honeypot_invalid_account" };
  if (/ComputeBudgetExceeded|MaxComputeUnitsExceeded/i.test(errStr)) return { ok: false, action: "bump_cu", reason: "needs_more_cu" };
  if (/BlockhashNotFound|BlockhashExpired/i.test(errStr)) return { ok: false, action: "retry", reason: "stale_blockhash" };
  if (errStr === "__timeout__") return { ok: false, action: "retry", reason: "sim_timeout" };
  return { ok: false, action: "block", reason: "unknown_sim_error" };
}

export async function simulatePreflight({ tx, rpcQuorum, options = {} }) {
  try {
    const raw = await rpcQuorum.quorumCall("simulateTransaction", tx, { replaceRecentBlockhash: options.replaceRecentBlockhash ?? true, sigVerify: false });
    const value = raw?.value || raw || {};
    const classification = classifySimulationError({ err: value.err, logs: value.logs || [] });
    return { ...classification, raw: value };
  } catch (e) {
    const classification = classifySimulationError({ err: "__timeout__" });
    return { ...classification, raw: { error: e.message } };
  }
}
```

- [ ] **Step 4: Run → PASS**

`npx vitest run tests/tx-simulator.test.js` → 11 pass.

- [ ] **Step 5: Full suite no regression**

- [ ] **Step 6: Commit**

```bash
git add tools/tx-simulator.js tests/tx-simulator.test.js
git commit -m "feat(exec-edge): tx-simulator preflight + error classifier"
```

---

## Task 5: jito-executor.js — adaptive retry orchestrator

**Files:**
- Create: `tools/jito-executor.js`
- Create: `tests/jito-executor.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/jito-executor.test.js`:
```js
import { describe, expect, it, vi } from "vitest";
import { submitWithAdaptiveRetry } from "../tools/jito-executor.js";

function makeDeps({ simResults = [{ ok: true, action: "proceed" }], landings = [true] } = {}) {
  let simIdx = 0;
  let landIdx = 0;
  return {
    simulator: { simulatePreflight: vi.fn(async () => simResults[Math.min(simIdx++, simResults.length - 1)]) },
    feeOracle: { refresh: vi.fn(async () => {}), getTip: vi.fn(() => 200_000), getPriorityFeeMicroLamports: vi.fn(() => 10000) },
    rpcQuorum: { quorumCall: vi.fn(async () => ({ blockhash: "BHASH", lastValidBlockHeight: 100 })) },
    jitoSubmit: vi.fn(async () => "BUNDLE_ID_X"),
    jitoAwait: vi.fn(async () => ({ landed: landings[Math.min(landIdx++, landings.length - 1)], status: { transactions: ["TX_HASH"] } })),
    wallet: { publicKey: { toString: () => "WALLET" }, secretKey: new Uint8Array(64) },
    txBuilder: vi.fn(({ tip, priorityFee, cuLimit, blockhash }) => ({ _tip: tip, _pfee: priorityFee, _cu: cuLimit, _bh: blockhash, sign: vi.fn() })),
    log: vi.fn(),
  };
}

describe("submitWithAdaptiveRetry", () => {
  it("happy path: 1 attempt, landed, telemetry shape", async () => {
    const deps = makeDeps();
    const r = await submitWithAdaptiveRetry({
      builtTxFactory: deps.txBuilder,
      wallet: deps.wallet,
      rpcQuorum: deps.rpcQuorum,
      feeOracle: deps.feeOracle,
      simulator: deps.simulator,
      jitoSubmit: deps.jitoSubmit,
      jitoAwait: deps.jitoAwait,
      maxAttempts: 5,
      attemptTimeoutMs: 3000,
      log: deps.log,
    });
    expect(r.hash).toBe("TX_HASH");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0].landed).toBe(true);
    expect(r.total_tip_lamports).toBe(200_000);
  });

  it("aborts when simulator returns block", async () => {
    const deps = makeDeps({ simResults: [{ ok: false, action: "block", reason: "honeypot_account_missing" }] });
    await expect(submitWithAdaptiveRetry({
      builtTxFactory: deps.txBuilder, wallet: deps.wallet, rpcQuorum: deps.rpcQuorum,
      feeOracle: deps.feeOracle, simulator: deps.simulator,
      jitoSubmit: deps.jitoSubmit, jitoAwait: deps.jitoAwait,
      maxAttempts: 5, attemptTimeoutMs: 3000, log: deps.log,
    })).rejects.toThrow(/honeypot_account_missing/);
    expect(deps.jitoSubmit).not.toHaveBeenCalled();
  });

  it("bump_cu loops same attempt up to cap", async () => {
    const deps = makeDeps({
      simResults: [{ ok: false, action: "bump_cu" }, { ok: false, action: "bump_cu" }, { ok: true, action: "proceed" }],
      landings: [true],
    });
    const r = await submitWithAdaptiveRetry({
      builtTxFactory: deps.txBuilder, wallet: deps.wallet, rpcQuorum: deps.rpcQuorum,
      feeOracle: deps.feeOracle, simulator: deps.simulator,
      jitoSubmit: deps.jitoSubmit, jitoAwait: deps.jitoAwait,
      maxAttempts: 5, attemptTimeoutMs: 3000, defaultCuLimit: 200_000, maxCuLimit: 1_400_000, log: deps.log,
    });
    expect(deps.simulator.simulatePreflight).toHaveBeenCalledTimes(3);
    expect(r.attempts).toHaveLength(1);
  });

  it("escalates on no-landing, succeeds on attempt 2", async () => {
    const deps = makeDeps({ simResults: [{ ok: true, action: "proceed" }, { ok: true, action: "proceed" }], landings: [false, true] });
    deps.feeOracle.getTip = vi.fn((u) => u === "critical" ? 500_000 : 200_000);
    const r = await submitWithAdaptiveRetry({
      builtTxFactory: deps.txBuilder, wallet: deps.wallet, rpcQuorum: deps.rpcQuorum,
      feeOracle: deps.feeOracle, simulator: deps.simulator,
      jitoSubmit: deps.jitoSubmit, jitoAwait: deps.jitoAwait,
      maxAttempts: 5, attemptTimeoutMs: 100, log: deps.log,
    });
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0].landed).toBe(false);
    expect(r.attempts[1].landed).toBe(true);
    expect(r.attempts[1].tip).toBeGreaterThan(r.attempts[0].tip);
  });

  it("throws max_retries_exceeded after maxAttempts no-land", async () => {
    const deps = makeDeps({ simResults: Array(10).fill({ ok: true, action: "proceed" }), landings: Array(10).fill(false) });
    await expect(submitWithAdaptiveRetry({
      builtTxFactory: deps.txBuilder, wallet: deps.wallet, rpcQuorum: deps.rpcQuorum,
      feeOracle: deps.feeOracle, simulator: deps.simulator,
      jitoSubmit: deps.jitoSubmit, jitoAwait: deps.jitoAwait,
      maxAttempts: 3, attemptTimeoutMs: 50, log: deps.log,
    })).rejects.toThrow(/max_retries_exceeded/);
  });

  it("tip respects maxTipLamports cap", async () => {
    const deps = makeDeps({ simResults: Array(10).fill({ ok: true, action: "proceed" }), landings: [false, false, true] });
    deps.feeOracle.getTip = vi.fn(() => 1_000_000);
    const r = await submitWithAdaptiveRetry({
      builtTxFactory: deps.txBuilder, wallet: deps.wallet, rpcQuorum: deps.rpcQuorum,
      feeOracle: deps.feeOracle, simulator: deps.simulator,
      jitoSubmit: deps.jitoSubmit, jitoAwait: deps.jitoAwait,
      maxAttempts: 5, attemptTimeoutMs: 50, maxTipLamports: 1_500_000, log: deps.log,
    });
    expect(r.attempts[r.attempts.length - 1].tip).toBeLessThanOrEqual(1_500_000);
  });

  it("calls feeOracle.refresh before each attempt", async () => {
    const deps = makeDeps({ simResults: [{ ok: true, action: "proceed" }, { ok: true, action: "proceed" }], landings: [false, true] });
    await submitWithAdaptiveRetry({
      builtTxFactory: deps.txBuilder, wallet: deps.wallet, rpcQuorum: deps.rpcQuorum,
      feeOracle: deps.feeOracle, simulator: deps.simulator,
      jitoSubmit: deps.jitoSubmit, jitoAwait: deps.jitoAwait,
      maxAttempts: 3, attemptTimeoutMs: 50, log: deps.log,
    });
    expect(deps.feeOracle.refresh).toHaveBeenCalledTimes(2);
  });

  it("retry action restarts attempt without consuming attempt counter", async () => {
    const deps = makeDeps({
      simResults: [{ ok: false, action: "retry", reason: "stale_blockhash" }, { ok: true, action: "proceed" }],
      landings: [true],
    });
    const r = await submitWithAdaptiveRetry({
      builtTxFactory: deps.txBuilder, wallet: deps.wallet, rpcQuorum: deps.rpcQuorum,
      feeOracle: deps.feeOracle, simulator: deps.simulator,
      jitoSubmit: deps.jitoSubmit, jitoAwait: deps.jitoAwait,
      maxAttempts: 5, attemptTimeoutMs: 50, log: deps.log,
    });
    expect(r.attempts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run → FAIL**

`npx vitest run tests/jito-executor.test.js` → module not found.

- [ ] **Step 3: Create `tools/jito-executor.js`**

```js
export class MaxRetriesExceededError extends Error {
  constructor({ attempts, simulate_history }) {
    super(`max_retries_exceeded after ${attempts.length} attempt(s)`);
    this.attempts = attempts;
    this.simulate_history = simulate_history;
    this.name = "MaxRetriesExceededError";
  }
}

export async function submitWithAdaptiveRetry({
  builtTxFactory,
  wallet,
  rpcQuorum,
  feeOracle,
  simulator,
  jitoSubmit,
  jitoAwait,
  urgency = "urgent",
  maxAttempts = 5,
  attemptTimeoutMs = 3000,
  defaultCuLimit = 200_000,
  maxCuLimit = 1_400_000,
  maxTipLamports = 5_000_000,
  log = () => {},
}) {
  const attempts = [];
  const simulate_history = [];
  const startedAt = Date.now();
  let prevTip = null;
  let cuLimit = defaultCuLimit;

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    await feeOracle.refresh();
    const blockhashRes = await rpcQuorum.quorumCall("getLatestBlockhash");
    let tip = attemptNo === 1
      ? feeOracle.getTip(urgency)
      : Math.max(prevTip * 1.5, feeOracle.getTip("critical"));
    tip = Math.min(Math.floor(tip), maxTipLamports);
    const priorityFee = feeOracle.getPriorityFeeMicroLamports(95);

    let attemptStarted = Date.now();
    // inner sim loop (bump_cu / retry actions don't count as attempts)
    let simAction = null;
    let tx = null;
    while (true) {
      tx = builtTxFactory({ tip, priorityFee, cuLimit, blockhash: blockhashRes.blockhash });
      if (typeof tx.sign === "function") tx.sign([wallet]);
      const sim = await simulator.simulatePreflight({ tx, rpcQuorum });
      simulate_history.push({ attempt_no: attemptNo, ...sim });
      simAction = sim.action;
      if (sim.action === "block") {
        throw new Error(`exec_edge_block: ${sim.reason}`);
      }
      if (sim.action === "bump_cu") {
        cuLimit = Math.min(Math.floor(cuLimit * 1.5), maxCuLimit);
        if (cuLimit >= maxCuLimit) {
          throw new Error(`exec_edge_block: cu_cap_reached`);
        }
        continue;
      }
      if (sim.action === "retry") {
        const fresh = await rpcQuorum.quorumCall("getLatestBlockhash");
        blockhashRes.blockhash = fresh.blockhash;
        continue;
      }
      // proceed
      break;
    }

    const bundleId = await jitoSubmit({ tx, wallet, tip });
    const landing = await jitoAwait({ bundleId, timeoutMs: attemptTimeoutMs });
    const landed = !!landing.landed;
    attempts.push({
      attempt_no: attemptNo,
      tip,
      priority_fee: priorityFee,
      sim_action: simAction,
      landed,
      elapsed_ms: Date.now() - attemptStarted,
    });
    if (landed) {
      const hash = landing.status?.transactions?.[0] || bundleId;
      const total_tip_lamports = attempts.reduce((s, a) => s + a.tip, 0);
      return {
        hash,
        attempts,
        total_tip_lamports,
        landing_time_ms: Date.now() - startedAt,
        simulate_history,
      };
    }
    prevTip = tip;
  }

  throw new MaxRetriesExceededError({ attempts, simulate_history });
}
```

- [ ] **Step 4: Run → PASS**

`npx vitest run tests/jito-executor.test.js` → 8 pass.

- [ ] **Step 5: Full suite no regression**

- [ ] **Step 6: Commit**

```bash
git add tools/jito-executor.js tests/jito-executor.test.js
git commit -m "feat(exec-edge): jito-executor adaptive retry orchestrator"
```

---

## Task 6: Wire singletons in index.js + accessor in tools/jupiter.js

**Files:**
- Modify: `index.js` (init + shutdown)
- Modify: `tools/jupiter.js` (use submitWithAdaptiveRetry when executionEdge.enabled)

- [ ] **Step 1: Add accessor module `tools/exec-edge-singletons.js`**

Create `tools/exec-edge-singletons.js`:
```js
let _rpcQuorum = null;
let _feeOracle = null;

export function setRpcQuorum(rq) { _rpcQuorum = rq; }
export function getRpcQuorum() { return _rpcQuorum; }
export function setFeeOracle(fo) { _feeOracle = fo; }
export function getFeeOracle() { return _feeOracle; }
export function shutdownSingletons() {
  try { _feeOracle?.stop(); } catch (_) {}
  try { _rpcQuorum?.shutdown(); } catch (_) {}
  _feeOracle = null;
  _rpcQuorum = null;
}
```

- [ ] **Step 2: Modify `index.js` — initialize singletons at startup**

Add import near other exec-edge-relevant imports (top of file):
```js
import { Connection } from "@solana/web3.js";
import { createRpcQuorum } from "./tools/rpc-quorum.js";
import { createFeeOracle } from "./tools/fee-oracle.js";
import { setRpcQuorum, setFeeOracle, shutdownSingletons } from "./tools/exec-edge-singletons.js";
```

Find an early init section (after `config` is loaded, near where wallet manager initializes). Add:
```js
if (config.executionEdge?.enabled) {
  const conns = config.executionEdge.rpcEndpoints.map(e => {
    const conn = new Connection(e.url, "confirmed");
    return {
      url: e.url,
      label: e.label,
      call: async (method, ...args) => {
        if (typeof conn[method] === "function") return conn[method](...args);
        throw new Error(`connection does not support ${method}`);
      },
    };
  });
  const rq = createRpcQuorum({
    endpoints: config.executionEdge.rpcEndpoints,
    timeoutMs: config.executionEdge.executor.rpcCallTimeoutMs,
    connectionFactory: () => conns,
    log,
  });
  setRpcQuorum(rq);
  const fo = createFeeOracle({ rpcQuorum: rq, config: config.executionEdge, log });
  fo.start();
  setFeeOracle(fo);
  log("exec_edge", `enabled, fee_oracle started, rpc_quorum active (${config.executionEdge.rpcEndpoints.length} endpoints)`);
}
```

In `shutdown()` (existing function at end of file), add BEFORE `process.exit(0)`:
```js
try { shutdownSingletons(); } catch (_) {}
```

- [ ] **Step 3: Modify `tools/jupiter.js` — use submitWithAdaptiveRetry when enabled**

Add imports at top:
```js
import { submitWithAdaptiveRetry } from "./jito-executor.js";
import { simulatePreflight } from "./tx-simulator.js";
import { getRpcQuorum, getFeeOracle } from "./exec-edge-singletons.js";
import { submitSwapBundle, awaitBundleLanding } from "./jito.js";
import { ComputeBudgetProgram, TransactionMessage } from "@solana/web3.js";
```

REPLACE the existing `swapViaJito` function body (around line 27-79) with:
```js
async function swapViaJito({ inputMint, outputMint, amountRaw, slippageBps, wallet, executionContext = {} }) {
  if (!config.executionEdge?.enabled) {
    // legacy path preserved as fallback
    return legacyJitoFlow({ inputMint, outputMint, amountRaw, slippageBps, wallet });
  }
  const rpcQuorum = getRpcQuorum();
  const feeOracle = getFeeOracle();
  if (!rpcQuorum || !feeOracle) {
    throw new Error("exec-edge enabled but singletons not initialized");
  }

  const quoteUrl = `${JUPITER_V6}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Jupiter v6 quote ${quoteRes.status}: ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  if (quote.error) throw new Error(`Jupiter v6 quote: ${quote.error}`);

  const builtTxFactory = async ({ tip, priorityFee, cuLimit, blockhash }) => {
    const swapRes = await fetch(`${JUPITER_V6}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: false,
        computeUnitPriceMicroLamports: priorityFee,
        prioritizationFeeLamports: 0,
      }),
    });
    if (!swapRes.ok) throw new Error(`Jupiter v6 swap ${swapRes.status}: ${await swapRes.text()}`);
    const swapData = await swapRes.json();
    return VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
  };

  const result = await submitWithAdaptiveRetry({
    builtTxFactory: async (args) => {
      const tx = await builtTxFactory(args);
      tx.sign([wallet]);
      return tx;
    },
    wallet,
    rpcQuorum,
    feeOracle,
    simulator: { simulatePreflight },
    jitoSubmit: async ({ tx, wallet: w, tip }) => submitSwapBundle({
      signedSwapTx: tx,
      wallet: w,
      recentBlockhash: tx.message.recentBlockhash,
      tipLamports: tip,
      region: config.jito.region || "fra",
      authToken: config.jito.authToken || null,
    }),
    jitoAwait: async ({ bundleId, timeoutMs }) => awaitBundleLanding({
      bundleId,
      region: config.jito.region || "fra",
      authToken: config.jito.authToken || null,
      timeoutMs,
    }),
    urgency: executionContext.urgency || "urgent",
    maxAttempts: config.executionEdge.executor.maxAttempts,
    attemptTimeoutMs: config.executionEdge.executor.attemptTimeoutMs,
    defaultCuLimit: config.executionEdge.executor.defaultCuLimit,
    maxCuLimit: config.executionEdge.executor.maxCuLimit,
    maxTipLamports: config.executionEdge.feeOracle.maxTipLamports,
    log,
  });

  log("swap", `Jito landed via exec_edge: tx=${result.hash} attempts=${result.attempts.length} tip=${result.total_tip_lamports} time=${result.landing_time_ms}ms`);
  return { hash: result.hash, amount_out: quote.outAmount ?? null, jito_bundle_id: result.hash, attempts: result.attempts, total_tip_lamports: result.total_tip_lamports, landing_time_ms: result.landing_time_ms };
}

// Legacy inline path preserved for rollback when executionEdge.enabled = false
async function legacyJitoFlow({ inputMint, outputMint, amountRaw, slippageBps, wallet }) {
  const quoteUrl = `${JUPITER_V6}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Jupiter v6 quote ${quoteRes.status}: ${await quoteRes.text()}`);
  const quote = await quoteRes.json();
  const swapRes = await fetch(`${JUPITER_V6}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 0 }),
  });
  const swapData = await swapRes.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
  tx.sign([wallet]);
  const bundleId = await submitSwapBundle({ signedSwapTx: tx, wallet, recentBlockhash: tx.message.recentBlockhash, tipLamports: config.jito.tipLamports, region: config.jito.region || "fra", authToken: config.jito.authToken || null });
  const landing = await awaitBundleLanding({ bundleId, region: config.jito.region || "fra", authToken: config.jito.authToken || null, timeoutMs: 30_000 });
  if (!landing.landed) throw new Error(`Jito bundle not landed: ${JSON.stringify(landing.status?.err)}`);
  return { hash: landing.status?.transactions?.[0] || bundleId, amount_out: quote.outAmount ?? null, jito_bundle_id: bundleId };
}
```

- [ ] **Step 4: Run full suite**

`npx vitest run 2>&1 | tail -3` → all tests pass.

- [ ] **Step 5: Dry-run smoke**

```bash
node index.js --dry-run > /tmp/ee-dryrun.log 2>&1 &
PID=$!
sleep 8
kill $PID 2>/dev/null
wait $PID 2>/dev/null
grep -iE "exec_edge|fee_oracle|rpc_quorum|error|fatal" /tmp/ee-dryrun.log | head -10
```

Expected: line containing `[exec_edge] enabled, fee_oracle started, rpc_quorum active (2 endpoints)`. No `ERROR/fatal` related to exec-edge.

- [ ] **Step 6: Commit**

```bash
git add tools/exec-edge-singletons.js tools/jupiter.js index.js
git commit -m "feat(exec-edge): wire singletons + integrate adaptive retry in swapToken"
```

---

## Task 7: Integration tests

**Files:**
- Create: `tests/execution-edge-integration.test.js`

- [ ] **Step 1: Write 3 integration scenarios**

Create `tests/execution-edge-integration.test.js`:
```js
import { describe, expect, it, vi } from "vitest";
import { submitWithAdaptiveRetry } from "../tools/jito-executor.js";

function setup({ simResults, landings, getTipFn }) {
  return {
    builtTxFactory: vi.fn(({ tip }) => ({ _tip: tip, sign: () => {}, message: { recentBlockhash: "BH" } })),
    wallet: { publicKey: { toString: () => "W" }, secretKey: new Uint8Array(64) },
    rpcQuorum: { quorumCall: vi.fn(async () => ({ blockhash: "BH", lastValidBlockHeight: 100 })) },
    feeOracle: {
      refresh: vi.fn(async () => {}),
      getTip: getTipFn || vi.fn(() => 200_000),
      getPriorityFeeMicroLamports: vi.fn(() => 5000),
    },
    simulator: { simulatePreflight: vi.fn(async () => simResults.shift() || { ok: true, action: "proceed" }) },
    jitoSubmit: vi.fn(async () => "BUNDLE"),
    jitoAwait: vi.fn(async () => ({ landed: landings.shift() ?? true, status: { transactions: ["FINAL_HASH"] } })),
  };
}

describe("execution-edge integration", () => {
  it("happy path: simulate ok → 1 attempt land → telemetry correct", async () => {
    const deps = setup({ simResults: [{ ok: true, action: "proceed" }], landings: [true] });
    const r = await submitWithAdaptiveRetry({ ...deps, maxAttempts: 5, attemptTimeoutMs: 100 });
    expect(r.hash).toBe("FINAL_HASH");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0].landed).toBe(true);
    expect(r.simulate_history).toHaveLength(1);
    expect(r.simulate_history[0].action).toBe("proceed");
    expect(r.total_tip_lamports).toBe(200_000);
  });

  it("tip escalation: attempt 1 no-land → attempt 2 with higher tip lands", async () => {
    let calls = 0;
    const getTipFn = vi.fn((u) => {
      calls++;
      return u === "critical" ? 600_000 : 200_000;
    });
    const deps = setup({
      simResults: [{ ok: true, action: "proceed" }, { ok: true, action: "proceed" }],
      landings: [false, true],
      getTipFn,
    });
    const r = await submitWithAdaptiveRetry({ ...deps, maxAttempts: 5, attemptTimeoutMs: 100 });
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0].tip).toBe(200_000);
    expect(r.attempts[1].tip).toBeGreaterThan(r.attempts[0].tip);
    expect(r.attempts[1].landed).toBe(true);
  });

  it("block on slippage: simulate slippage → throws + no submit", async () => {
    const deps = setup({ simResults: [{ ok: false, action: "block", reason: "slippage_exceeded" }], landings: [true] });
    await expect(submitWithAdaptiveRetry({ ...deps, maxAttempts: 5, attemptTimeoutMs: 100 })).rejects.toThrow(/slippage_exceeded/);
    expect(deps.jitoSubmit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run → PASS**

`npx vitest run tests/execution-edge-integration.test.js` → 3 pass.

- [ ] **Step 3: Final full suite + dry-run verification**

`npx vitest run 2>&1 | tail -3` → all tests pass.

```bash
node index.js --dry-run > /tmp/ee-final.log 2>&1 &
PID=$!
sleep 8
kill $PID 2>/dev/null
wait $PID 2>/dev/null
grep -iE "exec_edge|rug_monitor|error|fatal" /tmp/ee-final.log | head -15
```

Expected: both `[exec_edge] enabled...` AND `[RUG_MONITOR] enabled...` lines present. No fatal/error.

- [ ] **Step 4: Commit**

```bash
git add tests/execution-edge-integration.test.js
git commit -m "test(exec-edge): integration suite (happy/escalation/block)"
```

---

## Self-Review Checklist

- [ ] Spec coverage: Module spec sections → Tasks 2-5; config → Task 1; integration → Task 6; tests → Tasks 2-5 + 7
- [ ] Placeholder scan: no TBD/TODO, every code step has full code
- [ ] Type consistency: `createRpcQuorum`, `createFeeOracle`, `simulatePreflight`, `submitWithAdaptiveRetry`, `RpcQuorumError`, `MaxRetriesExceededError`, `setRpcQuorum`/`getRpcQuorum`/`setFeeOracle`/`getFeeOracle`/`shutdownSingletons` consistent across tasks
- [ ] Test count: 3 (config) + 7 (rpc-quorum) + 8 (fee-oracle) + 11 (tx-simulator) + 8 (jito-executor) + 3 (integration) = 40 new tests
