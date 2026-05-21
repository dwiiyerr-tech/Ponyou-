// strategy-evolution-engine.js
export class StrategyEvolutionEngine {
  #bus;
  #registry;
  #gate;
  #proposal;
  #degradationThreshold;
  #running = false;

  constructor({ bus, registry, gate, proposal, degradationThreshold = 0.75 }) {
    this.#bus = bus;
    this.#registry = registry;
    this.#gate = gate;
    this.#proposal = proposal;
    this.#degradationThreshold = degradationThreshold;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#bus.on("candidate", c => this.#handleCandidate(c));
  }

  stop() { this.#running = false; }

  async #handleCandidate(candidate) {
    const id = this.#registry.register({
      name: candidate.name,
      type: candidate.type,
      rules: candidate.rules ?? {},
      regime: candidate.regime ?? null,
      source: candidate.source ?? "evolution",
    });

    const gateResult = await this.#gate.evaluate(id);
    if (!gateResult.passed) {
      this.#registry.reject(id, gateResult.rejectReason);
      this.#bus.emit("gate_result", { id, passed: false, layer: gateResult.failedLayer });
      return;
    }

    this.#bus.emit("gate_result", { id, passed: true, scores: gateResult.scores });

    const propResult = await this.#proposal.submit({
      ...candidate,
      id,
      scores: gateResult.scores,
      evidence: gateResult.evidence,
    });

    if (propResult.status === "approved") {
      this.#registry.activate(id, gateResult.scores);
      this.#bus.emit("strategy_activated", { id, name: candidate.name, scores: gateResult.scores });
    } else {
      this.#registry.reject(id, `proposal ${propResult.status}`);
      this.#bus.emit("proposal_rejected", { id, status: propResult.status });
    }
  }

  async checkDegradation({ strategyId, currentLiveWinRate }) {
    if (currentLiveWinRate < this.#degradationThreshold) {
      this.#registry.deactivate(strategyId, `degraded: live win rate ${currentLiveWinRate} < ${this.#degradationThreshold}`);
      this.#bus.emit("strategy_degraded", { id: strategyId, currentLiveWinRate });
      return true;
    }
    return false;
  }
}
