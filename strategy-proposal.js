// strategy-proposal.js
export class StrategyProposal {
  #sendTelegram;
  #autoApproveConvictionMin;
  #proposalTimeoutMs;
  #pending = new Map();

  constructor({
    sendTelegram,
    autoApproveConvictionMin = 0.95,
    proposalTimeoutMs = 24 * 60 * 60 * 1000,
  }) {
    this.#sendTelegram = sendTelegram;
    this.#autoApproveConvictionMin = autoApproveConvictionMin;
    this.#proposalTimeoutMs = proposalTimeoutMs;
  }

  formatMessage({ id, name, type, conviction, scores, evidence, regime, reason }) {
    const fmt = (v) => (v != null ? `${(v * 100).toFixed(0)}%` : "n/a");
    const bt = fmt(scores?.backtest);
    const pt = fmt(scores?.paper);
    const lt = fmt(scores?.live);
    const btN = evidence?.bt?.trades ?? "?";
    const ptN = evidence?.pt?.trades ?? "?";
    const ltN = evidence?.lt?.trades ?? "?";
    return [
      `[PROPOSAL] Strategy Update`,
      `Name: ${name}`,
      `Type: ${type}`,
      `Conviction: ${fmt(conviction)}`,
      `Evidence:`,
      `  Backtest: ${bt} (${btN} sims)`,
      `  Paper:    ${pt} (${ptN} signals)`,
      `  Live:     ${lt} (${ltN} trades)`,
      `Regime: ${regime ?? "any"}`,
      `Reason: ${reason}`,
      ``,
      `Reply /approve_${id} or /reject_${id}`,
    ].join("\n");
  }

  async submit(candidate) {
    const { id, conviction, scores } = candidate;
    const allGatesAbove90 = ["backtest", "paper", "live"].every(k => (scores?.[k] ?? 0) >= 0.90);

    if (conviction >= this.#autoApproveConvictionMin && allGatesAbove90) {
      const msg = `[AUTO-APPROVED] ${candidate.name} — conviction ${(conviction * 100).toFixed(0)}%, all gates ≥ 90%`;
      await this.#sendTelegram(msg).catch(() => {});
      return { id, autoApproved: true, status: "approved" };
    }

    const msg = this.formatMessage(candidate);
    await this.#sendTelegram(msg).catch(() => {});

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ id, autoApproved: false, status: "timeout_rejected" });
      }, this.#proposalTimeoutMs);
      this.#pending.set(id, { resolve, timer });
    });
  }

  handleOperatorResponse(id, approved) {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.#pending.delete(id);
    entry.resolve({ id, autoApproved: false, status: approved ? "approved" : "rejected" });
    return true;
  }
}
