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
    expect(fo.getTip("normal")).toBe(400_000);
    expect(fo.getTip("urgent")).toBe(800_000);
    expect(fo.getTip("critical")).toBe(1_600_000);
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
