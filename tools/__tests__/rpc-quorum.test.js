import { describe, expect, it, vi } from "vitest";
import { createRpcQuorum } from "../rpc-quorum.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("rpc-quorum primary endpoint", () => {
  it("tries the primary endpoint before racing fallback endpoints", async () => {
    const primaryAttempt = deferred();
    const calls = [];
    const endpoints = [
      { url: "https://primary.example", label: "primary", primary: true },
      { url: "https://fallback.example", label: "fallback" },
    ];
    const conns = [
      {
        url: "https://primary.example",
        label: "primary",
        call: vi.fn(async () => {
          calls.push("primary");
          return primaryAttempt.promise;
        }),
      },
      {
        url: "https://fallback.example",
        label: "fallback",
        call: vi.fn(async () => {
          calls.push("fallback");
          return { from: "fallback" };
        }),
      },
    ];
    const rq = createRpcQuorum({
      endpoints,
      timeoutMs: 500,
      connectionFactory: () => conns,
    });

    const resultPromise = rq.quorumCall("getLatestBlockhash");
    await Promise.resolve();

    expect(calls).toEqual(["primary"]);
    expect(conns[1].call).not.toHaveBeenCalled();

    primaryAttempt.reject(new Error("primary unavailable"));

    await expect(resultPromise).resolves.toEqual({ from: "fallback" });
    expect(conns[1].call).toHaveBeenCalledTimes(1);
    rq.shutdown();
  });
});
