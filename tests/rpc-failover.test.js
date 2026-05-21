import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RpcFailover, createRpcFailover } from "../tools/rpcFailover.js";

describe("RpcFailover", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const endpoints = [
    { url: "https://rpc1.example.com", name: "primary" },
    { url: "https://rpc2.example.com", name: "backup1" },
    { url: "https://rpc3.example.com", name: "backup2" },
  ];

  it("returns first endpoint before any health check", () => {
    const f = new RpcFailover({ endpoints });
    // Before health checks, all latencyMs=Infinity, getEndpoint returns first healthy (all)
    const ep = f.getEndpoint();
    expect(ep.url).toBe("https://rpc1.example.com");
  });

  it("sorts by latency after checkHealth — lowest latency wins", async () => {
    let callCount = 0;
    fetch.mockImplementation(async (url) => {
      callCount++;
      // Simulate latency: rpc1=200ms, rpc2=50ms, rpc3=150ms
      const delays = {
        "https://rpc1.example.com": 200,
        "https://rpc2.example.com": 50,
        "https://rpc3.example.com": 150,
      };
      await new Promise((r) => setTimeout(r, delays[url] ?? 100));
      return { ok: true, json: async () => ({ result: "ok" }) };
    });

    const f = new RpcFailover({ endpoints });
    await f.checkHealth();
    const ep = f.getEndpoint();
    // rpc2 had lowest latency
    expect(ep.url).toBe("https://rpc2.example.com");
  });

  it("marks endpoint unhealthy after 3 consecutive failures", async () => {
    fetch.mockImplementation(async (url) => {
      if (url === "https://rpc1.example.com") throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({}) };
    });

    const f = new RpcFailover({ endpoints });
    await f.checkHealth(); // failure 1
    await f.checkHealth(); // failure 2
    await f.checkHealth(); // failure 3 → unhealthy

    const ep = f.getEndpoint();
    expect(ep.url).not.toBe("https://rpc1.example.com");
  });

  it("activates circuit breaker PAUSED when all endpoints fail", async () => {
    fetch.mockRejectedValue(new Error("network error"));

    const f = new RpcFailover({ endpoints });
    await f.checkHealth();
    await f.checkHealth();
    await f.checkHealth();

    expect(f.circuitState).toBe("PAUSED");
    expect(() => f.getEndpoint()).toThrow(/PAUSED/);
  });

  it("createRpcFailover factory accepts string array", () => {
    const f = createRpcFailover(["https://a.com", "https://b.com"]);
    expect(f).toBeInstanceOf(RpcFailover);
    const ep = f.getEndpoint();
    expect(ep.url).toBe("https://a.com");
  });
});
