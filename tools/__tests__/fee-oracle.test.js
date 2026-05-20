import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeeOracle, getHeliusPriorityFee } from "../fee-oracle.js";

const originalFetch = globalThis.fetch;

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
        return feeSamples.map(prioritizationFee => ({ prioritizationFee }));
      }
      throw new Error("unsupported in test");
    }),
  };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getHeliusPriorityFee", () => {
  it("returns priority fee estimate from Helius", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({ result: { priorityFeeEstimate: 123_456 } })),
    });

    const fee = await getHeliusPriorityFee("https://helius.example", "tx-base58");

    expect(fee).toBe(123_456);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://helius.example",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body)).toEqual({
      jsonrpc: "2.0",
      id: "1",
      method: "getPriorityFeeEstimate",
      params: [
        {
          transaction: "tx-base58",
          options: { priorityLevel: "High" },
        },
      ],
    });
  });

  it("returns null when Helius responds with an HTTP error", async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(getHeliusPriorityFee("https://helius.example")).resolves.toBeNull();
  });

  it("returns null without calling fetch when no RPC URL is configured", async () => {
    await expect(getHeliusPriorityFee()).resolves.toBeNull();

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("fee oracle Helius integration", () => {
  it("prefers cached Helius fee over percentile samples", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({ result: { priorityFeeEstimate: 900_000 } })),
    });
    const rq = makeRpcQuorum([100, 200, 300, 400]);
    const fo = createFeeOracle({
      rpcQuorum: rq,
      config: defaultConfig,
      heliusRpcUrl: "https://helius.example",
    });

    await fo.refresh();

    expect(fo.getPriorityFeeMicroLamports(75)).toBe(900_000);
    fo.stop();
  });

  it("includes helius_fee in mempool snapshots", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({ result: { priorityFeeEstimate: 321_000 } })),
    });
    const rq = makeRpcQuorum([100, 200, 300, 400]);
    const fo = createFeeOracle({
      rpcQuorum: rq,
      config: defaultConfig,
      heliusRpcUrl: "https://helius.example",
    });

    await fo.refresh();

    expect(fo.getMempoolSnapshot()).toMatchObject({ helius_fee: 321_000 });
    fo.stop();
  });
});
