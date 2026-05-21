import { describe, it, expect, vi } from "vitest";
import { StrategyEvolutionBus } from "../strategy-evolution-bus.js";

describe("StrategyEvolutionBus", () => {
  it("emits candidate event to subscriber", async () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 5 });
    const received = [];
    bus.on("candidate", c => received.push(c));
    await bus.enqueue({ id: "x1", name: "test", type: "select", rules: {} });
    await new Promise(r => setTimeout(r, 20));
    expect(received.length).toBe(1);
    expect(received[0].id).toBe("x1");
  });

  it("drops oldest and emits queue_overflow when queue exceeds maxQueue", async () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 1 });
    const overflows = [];
    bus.on("queue_overflow", w => overflows.push(w));
    bus.on("candidate", () => {});
    // First enqueue: processNext immediately shifts it (synchronous), queue stays empty.
    // Second enqueue: queue=[b], processing=true, no drain yet.
    // Third enqueue: queue.length=1 >= maxQueue=1 → overflow fires.
    await bus.enqueue({ id: "a" });
    await bus.enqueue({ id: "b" });
    await bus.enqueue({ id: "c" });
    await new Promise(r => setTimeout(r, 20));
    expect(overflows.length).toBeGreaterThan(0);
  });

  it("emits named events via bus.emit()", () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 5 });
    const received = [];
    bus.on("strategy_activated", e => received.push(e));
    bus.emit("strategy_activated", { id: "y1" });
    expect(received[0].id).toBe("y1");
  });

  it("processes multiple candidates sequentially", async () => {
    const bus = new StrategyEvolutionBus({ maxQueue: 10 });
    const order = [];
    bus.on("candidate", c => order.push(c.id));
    await bus.enqueue({ id: "first" });
    await bus.enqueue({ id: "second" });
    await bus.enqueue({ id: "third" });
    await new Promise(r => setTimeout(r, 50));
    expect(order).toEqual(["first", "second", "third"]);
  });
});
