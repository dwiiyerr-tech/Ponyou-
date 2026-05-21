import { EventEmitter } from "events";

const CANDIDATE_EVENT = "candidate";
const OVERFLOW_EVENT = "queue_overflow";
const CANDIDATE_ERROR_EVENT = "candidate_error";

function normalizeMaxQueue(maxQueue) {
  const value = Number(maxQueue);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("StrategyEvolutionBus: maxQueue must be a positive integer");
  }
  return value;
}

export class StrategyEvolutionBus extends EventEmitter {
  #queue = [];
  #maxQueue;
  #processing = false;
  #logger;

  constructor({ maxQueue = 5, logger = console } = {}) {
    super();
    this.#maxQueue = normalizeMaxQueue(maxQueue);
    this.#logger = logger;
  }

  get maxQueue() {
    return this.#maxQueue;
  }

  get queueSize() {
    return this.#queue.length;
  }

  get isProcessing() {
    return this.#processing;
  }

  async enqueue(candidate) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("StrategyEvolutionBus.enqueue requires a candidate object");
    }

    if (this.#queue.length >= this.#maxQueue) {
      const dropped = this.#queue.shift();
      const warning = {
        dropped,
        incoming: candidate,
        queueSize: this.#queue.length,
        maxQueue: this.#maxQueue,
      };
      this.#logger?.warn?.("StrategyEvolutionBus queue overflow: dropped oldest candidate");
      this.emit(OVERFLOW_EVENT, warning);
    }

    this.#queue.push(candidate);
    this.#scheduleDrain();
    return { accepted: true, queueSize: this.#queue.length };
  }

  async drain({ timeoutMs = 1000 } = {}) {
    const startedAt = Date.now();
    while (this.#processing || this.#queue.length > 0) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("StrategyEvolutionBus.drain timed out");
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  #scheduleDrain() {
    if (this.#processing) return;
    setImmediate(() => {
      void this.#drainQueue();
    });
  }

  async #drainQueue() {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#queue.length > 0) {
        const candidate = this.#queue.shift();
        await this.#emitCandidate(candidate);
      }
    } finally {
      this.#processing = false;
    }
  }

  async #emitCandidate(candidate) {
    const listeners = this.rawListeners(CANDIDATE_EVENT);
    for (const listener of listeners) {
      try {
        await listener.call(this, candidate);
      } catch (error) {
        this.emit(CANDIDATE_ERROR_EVENT, { candidate, error });
      }
    }
  }
}
