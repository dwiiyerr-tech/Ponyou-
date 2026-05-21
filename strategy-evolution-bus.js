// strategy-evolution-bus.js
import { EventEmitter } from "events";

export class StrategyEvolutionBus extends EventEmitter {
  #queue = [];
  #maxQueue;
  #processing = false;

  constructor({ maxQueue = 5 } = {}) {
    super();
    this.#maxQueue = maxQueue;
  }

  async enqueue(candidate) {
    if (this.#queue.length >= this.#maxQueue) {
      const dropped = this.#queue.shift();
      this.emit("queue_overflow", { dropped, queueSize: this.#queue.length });
    }
    this.#queue.push(candidate);
    if (!this.#processing) this.#processNext();
  }

  #processNext() {
    if (!this.#queue.length) { this.#processing = false; return; }
    this.#processing = true;
    const candidate = this.#queue.shift();
    setImmediate(() => {
      this.emit("candidate", candidate);
      this.#processNext();
    });
  }
}
