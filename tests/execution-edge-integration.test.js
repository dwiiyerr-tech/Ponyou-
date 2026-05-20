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
    const getTipFn = vi.fn((u) => u === "critical" ? 600_000 : 200_000);
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
