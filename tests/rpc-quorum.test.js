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
