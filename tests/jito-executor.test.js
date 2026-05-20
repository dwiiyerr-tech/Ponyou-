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
