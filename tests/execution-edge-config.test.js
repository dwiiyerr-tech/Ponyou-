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
