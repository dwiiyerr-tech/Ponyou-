import { describe, it, expect, vi } from "vitest";
import { StrategyEvolutionBus } from "../strategy-evolution-bus.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("StrategyEvolutionBus", () => {
  it("emits candidate event to subscriber", async () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 5, logger: null });
    const received = [];

    bus.on("candidate", candidate => received.push(candidate));

    await bus.enqueue({ id: "x1", name: "test", type: "select", rules: {} });
    await bus.drain();

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe("x1");
  });

  it("drops oldest queued candidate and emits queue_overflow when queue exceeds maxQueue", async () => {
    const logger = { warn: vi.fn() };
    const bus = new StrategyEvolutionBus({ maxQueue: 1, logger });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const overflows = [];
    const processed = [];

    bus.on("queue_overflow", warning => overflows.push(warning));
    bus.on("candidate", async candidate => {
      processed.push(candidate.id);
      if (candidate.id === "a") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });

    await bus.enqueue({ id: "a" });
    await firstStarted.promise;
    await bus.enqueue({ id: "b" });
    await bus.enqueue({ id: "c" });
    releaseFirst.resolve();
    await bus.drain();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(overflows).toHaveLength(1);
    expect(overflows[0].dropped.id).toBe("b");
    expect(overflows[0].incoming.id).toBe("c");
    expect(processed).toEqual(["a", "c"]);
  });

  it("emits named events via bus.emit()", () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 5, logger: null });
    const received = [];

    bus.on("strategy_activated", event => received.push(event));
    bus.emit("strategy_activated", { id: "y1" });

    expect(received[0].id).toBe("y1");
  });

  it("awaits async candidate subscribers before processing the next candidate", async () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 10, logger: null });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order = [];
    let active = 0;
    let maxActive = 0;

    bus.on("candidate", async candidate => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${candidate.id}`);

      if (candidate.id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }

      order.push(`end:${candidate.id}`);
      active -= 1;
    });

    await bus.enqueue({ id: "first" });
    await firstStarted.promise;
    await bus.enqueue({ id: "second" });
    await bus.enqueue({ id: "third" });

    expect(order).toEqual(["start:first"]);
    releaseFirst.resolve();
    await bus.drain();

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
      "start:third",
      "end:third",
    ]);
  });

  it("continues draining after subscriber errors and emits candidate_error", async () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 5, logger: null });
    const order = [];
    const errors = [];

    bus.on("candidate", candidate => {
      order.push(candidate.id);
      if (candidate.id === "bad") throw new Error("gate failed unexpectedly");
    });
    bus.on("candidate_error", event => errors.push(event));

    await bus.enqueue({ id: "bad" });
    await bus.enqueue({ id: "next" });
    await bus.drain();

    expect(order).toEqual(["bad", "next"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].candidate.id).toBe("bad");
    expect(errors[0].error.message).toMatch("gate failed");
  });
});
