// strategy-evolution-engine.js
export class StrategyEvolutionEngine {
  #bus;
  #registry;
  #gate;
  #proposal;
  #degradationThreshold;
  #running = false;

  constructor({ bus, registry, gate, proposal, degradationThreshold = 0.75 } = {}) {
    this.#bus = bus;
    this.#registry = registry;
    this.#gate = gate;
    this.#proposal = proposal;
    this.#degradationThreshold = degradationThreshold;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#bus.on("candidate", c => {
      this.#handleCandidate(c).catch(e => {
        this.#bus.emit("evolution_error", {
          stage: "handleCandidate",
          name: c?.name,
          error: e?.message || String(e),
        });
      });
    });
  }

  stop() { this.#running = false; }

  async #handleCandidate(candidate) {
    let id;
    try {
      id = this.#registry.register({
        name: candidate.name,
        type: candidate.type,
        rules: candidate.rules ?? {},
        regime: candidate.regime ?? null,
        source: candidate.source ?? "evolution",
      });
    } catch (e) {
      this.#bus.emit("evolution_error", { stage: "register", name: candidate?.name, error: e?.message || String(e) });
      return;
    }

    let gateResult;
    try {
      gateResult = await this.#gate.evaluate(id);
    } catch (e) {
      try { this.#registry.reject(id, `gate threw: ${e?.message || e}`); } catch (re) { this.#bus.emit("evolution_error", { stage: "registry_reject", id, error: re?.message || String(re) }); }
      this.#bus.emit("evolution_error", { stage: "gate", id, error: e?.message || String(e) });
      return;
    }
    if (!gateResult.passed) {
      this.#registry.reject(id, gateResult.rejectReason);
      this.#bus.emit("gate_result", { id, passed: false, layer: gateResult.failedLayer });
      return;
    }

    this.#bus.emit("gate_result", { id, passed: true, scores: gateResult.scores });

    let propResult;
    try {
      // Merge gate evidence with the producer's fundamental evidence so the
      // Telegram proposal can render BOTH the WR escalation bars (from gate)
      // AND the fundamental snapshot (sources, maturity, sampled mints/wallets).
      const mergedEvidence = {
        ...gateResult.evidence,
        ...(candidate?.evidence ? { fundamental: candidate.evidence } : {}),
      };
      propResult = await this.#proposal.submit({
        ...candidate,
        id,
        scores: gateResult.scores,
        evidence: mergedEvidence,
      });
    } catch (e) {
      try { this.#registry.reject(id, `proposal threw: ${e?.message || e}`); } catch (re) { this.#bus.emit("evolution_error", { stage: "registry_reject", id, error: re?.message || String(re) }); }
      this.#bus.emit("evolution_error", { stage: "proposal", id, error: e?.message || String(e) });
      return;
    }

    if (propResult.status === "approved") {
      this.#registry.activate(id, gateResult.scores);
      this.#bus.emit("strategy_activated", { id, name: candidate.name, scores: gateResult.scores });
    } else {
      this.#registry.reject(id, `proposal ${propResult.status}`);
      this.#bus.emit("proposal_rejected", { id, status: propResult.status });
    }
  }

  async checkDegradation({ strategyId, currentLiveWinRate, liveTrades = null }) {
    // SEE-1: require a minimum sample before deactivating. Previously a
    // strategy with only 4 trades (1 loss = 75% WR → 2 losses = 50% WR)
    // could be flagged DEGRADED purely from noise. scanAllDegradations
    // already enforces 25+ trades — this entrypoint now matches.
    const MIN_TRADES_FOR_DEGRADATION = 25;
    if (liveTrades != null && liveTrades < MIN_TRADES_FOR_DEGRADATION) {
      return false;
    }
    if (currentLiveWinRate < this.#degradationThreshold) {
      const sampleSuffix = liveTrades != null ? ` (${liveTrades} trades)` : "";
      this.#registry.deactivate(strategyId, `degraded: live win rate ${currentLiveWinRate} < ${this.#degradationThreshold}${sampleSuffix}`);
      this.#bus.emit("strategy_degraded", { id: strategyId, currentLiveWinRate, liveTrades });
      return true;
    }
    return false;
  }

  /**
   * Scan ALL active strategies for degradation. Called periodically
   * (daily cron) so degraded strategies auto-deactivate without
   * operator intervention.
   */
  async scanAllDegradations({ getTradeAttribution = null } = {}) {
    const active = (this.#registry.getAll() || []).filter(s => s.status === "active");
    const degraded = [];
    for (const strategy of active) {
      const liveWinRate = normalizeRate(strategy.scores?.live);
      if (liveWinRate == null) continue;
      const liveTrades = Number(strategy.evidence?.live?.trades ?? strategy.scores?.liveTrades ?? 0);
      // Only evaluate strategies with enough live data — ignore small samples
      if (liveTrades < 25) continue;
      if (liveWinRate < this.#degradationThreshold) {
        this.#registry.deactivate(strategy.id, `auto-degraded: live WR ${(liveWinRate*100).toFixed(0)}% < ${(this.#degradationThreshold*100).toFixed(0)}% (${liveTrades} trades)`);
        this.#bus.emit("strategy_degraded", { id: strategy.id, liveWinRate, liveTrades });
        degraded.push({ id: strategy.id, name: strategy.name, liveWinRate, liveTrades });
      }
    }
    if (degraded.length > 0) {
      this.#bus.emit("degradation_scan", { degraded, scanned: active.length });
    }
    return degraded;
  }
}

function normalizeRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n >= 1 ? n / 100 : n;
}
