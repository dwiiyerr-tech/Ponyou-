// strategy-proposal.js
//
// Proposal envelope that gets pushed to Telegram when the StrategyGate has
// cleared a candidate. The message must be operator-actionable: it should
// answer, at a glance, "should I /approve this?" without the operator
// needing to dig into logs.
//
// Auto-approve gating (matches the user spec):
//   - Conviction      ≥ autoApproveConvictionMin (default 0.95)
//   - All gates       ≥ autoApproveMinGateRate   (default 0.90 → WR 90%)
//   - Data maturity   ≥ autoApproveMinMaturityDays (default 30)
//
// Anything not meeting auto-approve falls back to operator review with a
// 24h timeout. Failing the maturity gate disables auto-approve entirely so
// the operator must consciously sign off on a young agent's first strategy.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __spDirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_AUTO_APPROVE_CONVICTION = 0.95;
const DEFAULT_AUTO_APPROVE_MIN_GATE   = 0.90;
const DEFAULT_AUTO_APPROVE_MATURITY   = 30;
const DEFAULT_PROPOSAL_TIMEOUT_MS     = 24 * 60 * 60 * 1000;

// Fresh-read the proposal gate from user-config.json so /autonomy toggles
// take effect without a bot restart. Falls back to the constructor default.
function _gateEnabledFresh(fallback) {
  try {
    const ucPath = path.join(__spDirname, "user-config.json");
    if (fs.existsSync(ucPath)) {
      const uc = JSON.parse(fs.readFileSync(ucPath, "utf8"));
      if (uc.autonomyMode === "full_auto") return false;
      if (uc.strategyProposalEnabled === false) return false;
      if (uc.strategyProposalEnabled === true) return true;
    }
  } catch {}
  return fallback;
}

function pct(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "n/a";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function escalationBar(scores = {}) {
  // ASCII visualization 80% → 100% — operator immediately sees how far each
  // gate has climbed above the minimum 80% threshold. Width is fixed so the
  // Telegram message stays readable on mobile.
  const BAR_WIDTH = 10;
  const renderBar = (rate) => {
    const n = Number(rate);
    if (!Number.isFinite(n) || n < 0) return "□".repeat(BAR_WIDTH);
    const clamped = Math.min(1, Math.max(0, n));
    const filled = Math.round(clamped * BAR_WIDTH);
    return "█".repeat(filled) + "□".repeat(BAR_WIDTH - filled);
  };
  return {
    backtest: renderBar(scores?.backtest),
    paper:    renderBar(scores?.paper),
    live:     renderBar(scores?.live),
  };
}

export class StrategyProposal {
  #sendTelegram;
  #autoApproveConvictionMin;
  #autoApproveMinGateRate;
  #autoApproveMinMaturityDays;
  #proposalTimeoutMs;
  #proposalEnabled;   // when false: skip Telegram gate, auto-approve everything
  #pending = new Map();

  constructor({
    sendTelegram,
    autoApproveConvictionMin = DEFAULT_AUTO_APPROVE_CONVICTION,
    autoApproveMinGateRate = DEFAULT_AUTO_APPROVE_MIN_GATE,
    autoApproveMinMaturityDays = DEFAULT_AUTO_APPROVE_MATURITY,
    proposalTimeoutMs = DEFAULT_PROPOSAL_TIMEOUT_MS,
    proposalEnabled = true,
  }) {
    this.#sendTelegram = sendTelegram;
    this.#autoApproveConvictionMin = autoApproveConvictionMin;
    this.#autoApproveMinGateRate = autoApproveMinGateRate;
    this.#autoApproveMinMaturityDays = autoApproveMinMaturityDays;
    this.#proposalTimeoutMs = proposalTimeoutMs;
    this.#proposalEnabled = proposalEnabled;
  }

  formatMessage({ id, name, type, conviction, scores, evidence, regime, reason } = {}) {
    const bars = escalationBar(scores);
    const btN = evidence?.backtest?.trades ?? evidence?.bt?.trades ?? "?";
    const ptN = evidence?.paper?.trades ?? evidence?.pt?.trades ?? "?";
    const ltN = evidence?.live?.trades ?? evidence?.lt?.trades ?? "?";
    const profitFactor = evidence?.backtest?.profitFactor ?? evidence?.bt?.profitFactor;

    // Fundamental signals injected by the producer (optional — proposal
    // still renders if the candidate didn't come from the producer).
    const fundamental = evidence?.fundamental || null;
    const composite = fundamental?.scores?.composite_strength;
    const sources = Array.isArray(fundamental?.sources) ? fundamental.sources.join(", ") : null;
    const sampledMints = Array.isArray(fundamental?.sampledMints) ? fundamental.sampledMints.length : null;
    const sampledWallets = Array.isArray(fundamental?.sampledWallets) ? fundamental.sampledWallets.length : null;
    const maturity = fundamental?.maturity || null;

    const lines = [
      `[PROPOSAL] Strategy Activation Request`,
      `Name: ${name ?? "(unnamed)"}`,
      `Type: ${type ?? "(unknown)"}`,
      `Conviction: ${pct(conviction)}`,
      ``,
      `Win-rate evidence (target 80%→100%):`,
      `  Backtest:  ${bars.backtest} ${pct(scores?.backtest)}  (${btN} sims${profitFactor ? `, PF ${Number(profitFactor).toFixed(2)}` : ""})`,
      `  Paper:     ${bars.paper} ${pct(scores?.paper)}  (${ptN} signals)`,
      `  Live:      ${bars.live} ${pct(scores?.live)}  (${ltN} trades)`,
    ];

    if (fundamental) {
      lines.push("");
      lines.push("Fundamental evidence:");
      if (composite != null) lines.push(`  Composite strength: ${composite.toFixed(1)} / 100`);
      if (sources) lines.push(`  Sources:            ${sources}`);
      if (sampledMints != null) lines.push(`  Sampled mints:      ${sampledMints}`);
      if (sampledWallets != null) lines.push(`  Sampled wallets:    ${sampledWallets}`);
      if (maturity?.ageDays != null) {
        const matStr = `${maturity.ageDays.toFixed(1)}d`;
        const matWarn = maturity.ageDays < this.#autoApproveMinMaturityDays ? " ⚠ below auto-approve threshold" : "";
        lines.push(`  Data maturity:      ${matStr}${matWarn}`);
      }
    }

    lines.push("");
    lines.push(`Regime: ${regime ?? "any"}`);
    if (reason) lines.push(`Reason: ${reason}`);

    lines.push("");
    lines.push(`Reply /approve_${id} or /reject_${id}`);
    return lines.join("\n");
  }

  #autoApprovalDecision(candidate) {
    const { conviction = 0, scores = {}, evidence = {} } = candidate || {};
    const allGatesAboveMin = ["backtest", "paper", "live"]
      .every(key => (scores?.[key] ?? 0) >= this.#autoApproveMinGateRate);
    const convictionPasses = Number(conviction) >= this.#autoApproveConvictionMin;
    const maturityDays = evidence?.fundamental?.maturity?.ageDays
      ?? evidence?.maturity?.ageDays
      ?? null;
    const maturityPasses = this.#autoApproveMinMaturityDays <= 0
      || (maturityDays != null && maturityDays >= this.#autoApproveMinMaturityDays);
    return {
      ok: convictionPasses && allGatesAboveMin && maturityPasses,
      convictionPasses,
      allGatesAboveMin,
      maturityPasses,
      maturityDays,
    };
  }

  async submit(candidate) {
    const { id, conviction, scores } = candidate || {};
    const decision = this.#autoApprovalDecision(candidate);

    // proposalEnabled=false: skip gate entirely, auto-approve all proposals.
    // Re-read fresh from disk so /autonomy full_auto applies without restart.
    if (!_gateEnabledFresh(this.#proposalEnabled)) {
      const msg = `[AUTO-APPLIED — gate off] ${candidate.name}\nConviction ${pct(conviction)}\nUse /proposals_on to re-enable approval gate.`;
      await this.#sendTelegram(msg).catch(() => {});
      return { id, autoApproved: true, status: "approved", gateDisabled: true, decision };
    }

    if (decision.ok) {
      const msg = [
        `[AUTO-APPROVED] ${candidate.name}`,
        `Conviction ${pct(conviction)}, all gates ≥ ${pct(this.#autoApproveMinGateRate)}`,
        `Data maturity: ${decision.maturityDays?.toFixed?.(1) ?? "?"}d ≥ ${this.#autoApproveMinMaturityDays}d`,
      ].join("\n");
      await this.#sendTelegram(msg).catch(() => {});
      return { id, autoApproved: true, status: "approved", decision };
    }

    const msg = this.formatMessage(candidate);
    await this.#sendTelegram(msg).catch(() => {});

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ id, autoApproved: false, status: "timeout_rejected", decision });
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

export { escalationBar };
