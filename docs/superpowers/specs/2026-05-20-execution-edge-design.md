# Execution Edge — Jito + Simulate + Multi-RPC + Adaptive Retry

**Status:** Draft (spec) | **Date:** 2026-05-20 | **Sub-project:** A of upgrade roadmap (B✅→A→C→D→E)

## Problem

Current Solana memecoin swap path goes through Jupiter Ultra API with single RPC, no pre-send simulation, hardcoded `prioritizationFeeLamports: 0`, and Jito infrastructure that is fully coded but disabled in config. During congestion, transactions may fail to land, get sandwiched by MEV bots, or burn gas on simulatable errors (honeypots, slippage). For memecoin scalping where seconds determine PnL, this is the second-largest source of capital leakage after rug exposure.

## Goal

Land swap transactions reliably and quickly via Jito bundles, with adaptive fee escalation, multi-RPC redundancy, and pre-send error filtering. Achieve ≥90% first-attempt landing rate at median ≤1.5s in normal network conditions.

## Non-goals

- MEV post-fill detection (sandwich attack analysis) — deferred to future sub-project
- Custom RPC providers beyond Solana public + Serum (operator adds via config)
- Multi-region Jito failover (single configured region)
- Cross-DEX execution routing (Jupiter handles aggregation)
- Transaction replay protection beyond Jito's built-in
- Fee accounting telemetry (returned in execution result, no UI)

## Architecture

**4 new modules** plus integration in `tools/jupiter.js`:

| File | Size target | Responsibility |
|---|---|---|
| `tools/fee-oracle.js` | ~120 LOC | Periodic mempool sampling; `getTip(urgency)` + `getPriorityFeeMicroLamports(percentile)` |
| `tools/rpc-quorum.js` | ~100 LOC | Multi-RPC race client; `quorumCall(method, ...args)` returning first success |
| `tools/tx-simulator.js` | ~150 LOC | `simulatePreflight(tx, rpcQuorum)` returning `{ ok, action, reason }` |
| `tools/jito-executor.js` | ~200 LOC | `submitWithAdaptiveRetry(...)`; orchestrates simulate → fee oracle → Jito bundle → retry escalation |

**Modified files:**
- `tools/jupiter.js` — `swapToken` calls `jito-executor.submitWithAdaptiveRetry` instead of inline Jito logic
- `user-config.json` — set `jitoEnabled: true` + new `executionEdge` config block
- `config.js` — parse `executionEdge` block with defaults
- `index.js` — initialize fee-oracle + rpc-quorum singletons at startup

**Preserved (no-touch):**
- `tools/jito.js` — existing low-level Jito client (used by jito-executor)
- `tools/dexscreener.js`, `tools/rug-signals.js`, etc.

## Data Flow

```
swapToken (jupiter.js)
  → build Jupiter v6 quote → signed VersionedTransaction
  → jito-executor.submitWithAdaptiveRetry(tx)
       ├── tx-simulator.simulatePreflight(tx)        ← block on real errors
       │     └── rpc-quorum.quorumCall(simulateTransaction)
       ├── fee-oracle.getTip("urgent")                ← read cached mempool stats
       ├── Jito bundle submit (tools/jito.js)
       ├── if not landed in attemptTimeoutMs:
       │     fee-oracle.refresh()                    ← force fresh sample
       │     escalate tip → retry
       └── return { hash, attempts, total_tip_lamports, landing_time_ms }
```

## Module: rpc-quorum.js

**Public API:**

```js
export function createRpcQuorum({ endpoints, timeoutMs = 2000, log })
// returns:
//   .quorumCall(methodName, ...args) → Promise<result>
//   .healthSnapshot()                → { [url]: { latencyMs, successRate, lastError } }
//   .shutdown()
```

**Behavior:**

- `endpoints`: array of `{ url, label, weight = 1 }` from `config.executionEdge.rpcEndpoints`
- Each `quorumCall` sends to all endpoints in parallel via `Promise.race` and aborts the others on first success
- Per-endpoint health: rolling latency (last 20 calls) + success rate
- Endpoint with `successRate < 0.5` is skipped from race for 60s (cooldown), then re-enabled

**Whitelisted methods** (avoid side-effect double-execute):
- `getLatestBlockhash`
- `getRecentPrioritizationFees`
- `simulateTransaction`
- `getAccountInfo`
- `getBalance`

`sendTransaction` is **blocked** — race-send would double-submit. The jito-executor owns sends.

**Error contract:** all endpoints fail → throw `RpcQuorumError({ method, endpoint_errors })`. Empty endpoints array throws at construction.

## Module: fee-oracle.js

**Public API:**

```js
export function createFeeOracle({ rpcQuorum, config, log })
// returns:
//   .getPriorityFeeMicroLamports(percentile = 75) → number
//   .getTip(urgency = "normal")                    → lamports
//   .getMempoolSnapshot()                          → { fee_p50, fee_p75, fee_p95, sampled_at, tip_recommendation }
//   .refresh()                                     → Promise
//   .start() / .stop()                             // background periodic sampler
```

**Sampling:**

- Periodic `getRecentPrioritizationFees` every `sampleIntervalMs` (default 10s) via rpcQuorum
- Cache last sample with `sampled_at`; serve from cache if newer than `cacheStaleMs` (default 15s)
- `refresh()` forces immediate fresh sample (used by jito-executor between retries)

**Tip and priority fee are two distinct values:**

- **Tip** (lamports) — bids tx into Jito bundle inclusion
- **Priority fee** (micro-lamports per CU) — bids tx into the next block via standard Solana priority

**Tip calculation (urgency multiplier × congestion factor):**

```
congestion_factor = clamp(priorityFeeP75_microLamports / 50_000, 1, 5)   // 1x at baseline, up to 5x in extreme congestion
urgency_multiplier = { normal: 1, urgent: 2, critical: 4 }[urgency]
tip = baseTipLamports * urgency_multiplier * congestion_factor
tip = min(tip, maxTipLamports)
```

Where `baseTipLamports` = `config.jito.tipLamports` (default 100_000).

**Priority fee:** `getPriorityFeeMicroLamports(p)` returns p-th percentile from recent samples in micro-lamports per CU. Used by simulator and as fallback when Jito disabled. Capped at `maxPriorityFeeMicroLamports`.

**Caps (guardrails against runaway cost):**
- Tip hard cap: `config.executionEdge.feeOracle.maxTipLamports` (default 5_000_000 = 0.005 SOL)
- Priority fee hard cap: `config.executionEdge.feeOracle.maxPriorityFeeMicroLamports` (default 10_000_000)

**Lifecycle:** started at app boot in `index.js`, stopped on SIGTERM.

## Module: tx-simulator.js

**Public API:**

```js
export async function simulatePreflight({ tx, rpcQuorum, options = {} })
// returns: { ok: boolean, action: "proceed" | "block" | "retry" | "bump_cu", reason, raw }
```

**Error classification (hybrid policy — block on real errors, retry on transient):**

| Simulation result | Action | Reason |
|---|---|---|
| `success` (no err) | `proceed` | "clean" |
| `InsufficientFundsForRent` / `InsufficientFunds` | `block` | "insufficient_balance" |
| `Custom 6001` (Jupiter slippage) / `ExceededSlippage` | `block` | "slippage_exceeded" |
| `AccountNotFound` (output account) | `block` | "honeypot_account_missing" |
| `Program error: InvalidAccountData` in token program | `block` | "honeypot_invalid_account" |
| `ComputeBudgetExceeded` / `MaxComputeUnitsExceeded` | `bump_cu` | "needs_more_cu" (retry with CU 1.5x) |
| `BlockhashNotFound` / `BlockhashExpired` | `retry` | "stale_blockhash" |
| Network timeout (sim itself) | `retry` | "sim_timeout" |
| Unknown error | `block` (fail-closed) | "unknown_sim_error" |

**Options:**
- `cuLimit`: if set, sim uses this `computeUnitLimit` (used by bump_cu retry loop)
- `replaceRecentBlockhash`: default true — sim uses freshest blockhash

**`raw`:** original `simulateTransaction` result preserved for debugging.

## Module: jito-executor.js

**Public API:**

```js
export async function submitWithAdaptiveRetry({
  builtTx,           // unsigned VersionedTransaction
  wallet,            // signer (Keypair)
  rpcQuorum,         // for blockhash + simulate
  feeOracle,         // for tip + priority fee
  urgency = "urgent",
  maxAttempts = 5,
  attemptTimeoutMs = 3000,
  log,
})
// returns: { hash, attempts, total_tip_lamports, landing_time_ms, simulate_history }
// throws:  { error, attempts, simulate_history } on terminal failure
```

**Retry escalation flow:**

```
attempt 1:
  blockhash    ← rpcQuorum.quorumCall("getLatestBlockhash")
  feeOracle.refresh()                       // fresh mempool sample
  tip          ← feeOracle.getTip(urgency)
  cuLimit      ← config.executionEdge.executor.defaultCuLimit (default 200_000)
  rebuild + sign tx
  
  simResult ← simulatePreflight(tx)
  if simResult.action === "block":     throw { reason: simResult.reason }
  if simResult.action === "bump_cu":   cuLimit *= 1.5 (cap at maxCuLimit), restart attempt
  if simResult.action === "retry":     refresh blockhash, restart attempt (no attempt count)
  // else: proceed
  
  submit via Jito (tools/jito.js submitSwapBundle)
  await landing for attemptTimeoutMs (default 3s)
  if landed: return success

attempt 2..N:
  feeOracle.refresh()
  newTip          ← max(prevTip * 1.5, feeOracle.getTip("critical"))    // adaptive
  newPriorityFee  ← feeOracle.getPriorityFeeMicroLamports(95)
  rebuild tx with new tip + priority fee + fresh blockhash
  re-simulate (preflight)
  submit + await landing

after maxAttempts:
  throw { error: "max_retries_exceeded", attempts, simulate_history }
```

**Adaptive tip profile:**
- attempt N tip = `max(prev * 1.5, feeOracle.getTip("critical"))`
- caps at `maxTipLamports`; if cap reached → tip stays at max, retry continues until `maxAttempts` exhausted

**Compute budget handling:**
- Default: 200_000 CU
- On `bump_cu`: `cuLimit *= 1.5` (cap at 1_400_000 = Solana per-tx max)
- Tx rebuilt with new `ComputeBudgetInstruction.setComputeUnitLimit` prepended

**Telemetry returned:**
- `attempts`: array of `{ attempt_no, tip, priority_fee, sim_action, landed, elapsed_ms }`
- `total_tip_lamports`: sum across attempts (cost visibility)
- `landing_time_ms`: ms from first attempt to landing
- `simulate_history`: array of sim results for debugging

## Integration in tools/jupiter.js

Replace existing inline `swapViaJito` (lines 27-79). After building the signed VersionedTransaction:

```js
const { hash, attempts, total_tip_lamports, landing_time_ms } = await submitWithAdaptiveRetry({
  builtTx: tx,
  wallet,
  rpcQuorum: getRpcQuorum(),
  feeOracle: getFeeOracle(),
  urgency: executionContext.urgency || "urgent",
  log,
});
log("swap", `Jito landed: tx=${hash} attempts=${attempts.length} tip=${total_tip_lamports} time=${landing_time_ms}ms`);
return {
  success: true,
  hash,
  ...,
  execution_provider: "jito",
  attempts,
  total_tip_lamports,
  landing_time_ms,
};
```

`getRpcQuorum()` and `getFeeOracle()` are singletons created in `index.js` at startup and exposed via small accessor functions.

## Error Handling Matrix

| Scenario | Behavior |
|---|---|
| All RPC endpoints down | `rpc-quorum.quorumCall` throws `RpcQuorumError`; jito-executor falls back to single primary RPC; if that also fails → terminal error |
| Jito region unreachable | jito-executor falls back to direct `sendTransaction` via rpcQuorum primary, escalating priority fee instead of tip |
| `simulatePreflight` returns `block` | jito-executor throws terminal error with reason — swap aborts cleanly, no position opened |
| `bump_cu` simulator action | jito-executor restarts same attempt with `cuLimit *= 1.5`; tip/blockhash unchanged |
| `retry` simulator action (stale blockhash) | jito-executor restarts same attempt with fresh blockhash; not counted against `maxAttempts` |
| Bundle submitted but not landed in `attemptTimeoutMs` | counted as 1 attempt; escalate tip; retry |
| `maxAttempts` exceeded | throws with full `simulate_history` + cost tally; caller logs + Telegram alert |
| fee-oracle sample fails | serves stale cache up to 60s; beyond that, falls back to `baseTipLamports` defaults |
| `executionEdge.enabled = false` in config | All new modules bypass — original Jupiter Ultra path preserved for rollback |
| Wallet keypair missing | Throws at simulate stage; never submits |

## Configuration

Added to `user-config.json` (defaults applied in `config.js`):

```json
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

Plus flip top-level `"jitoEnabled": true` in user-config to enable Jito globally.

## Testing

**Unit tests:**

| File | Tests | Focus |
|---|---|---|
| `tests/fee-oracle.test.js` | 8 | tip tiers, cache hit/miss, refresh, caps, percentile math |
| `tests/rpc-quorum.test.js` | 7 | race-to-first, health snapshot, cooldown, whitelist enforcement, all-fail error |
| `tests/tx-simulator.test.js` | 10 | each error classification, unknown = block fail-closed |
| `tests/jito-executor.test.js` | 8 | retry escalation, sim block aborts, bump_cu loop, max attempts, telemetry shape |

**Integration tests** (`tests/execution-edge-integration.test.js`):
- Happy path: simulate ok → 1 attempt land → telemetry correct
- Tip escalation: 1st attempt no-land → 2nd attempt with higher tip lands
- Block on slippage: simulate returns slippage_exceeded → no submit, error propagates

**Mocking conventions:**
- `rpcQuorum.quorumCall` mocked via `vi.fn` returning canned RPC responses
- `feeOracle.getTip` / `getPriorityFeeMicroLamports` mocked with deterministic values
- Jito bundle submit mocked to control landed/not-landed per attempt
- No real RPC / Jito calls in tests

Manual smoke test via `--dry-run` to verify wiring.

## Success Criteria

- Jito enabled by default in user-config
- First-attempt landing rate ≥ 90% in normal network conditions
- Median landing time ≤ 1.5s on first attempt
- All 33 unit + 3 integration tests passing
- No regression in existing 353 tests
- Dry-run logs: `[exec_edge] enabled, fee_oracle started, rpc_quorum active (2 endpoints)`
- Telegram receives notification on `max_retries_exceeded` errors
- Operator can disable via `executionEdge.enabled: false` for instant rollback
