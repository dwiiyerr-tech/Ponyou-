import { describe, it, expect, vi } from "vitest";
import { StrategyProposal } from "../strategy-proposal.js";

describe("StrategyProposal", () => {
  it("formats proposal message with all evidence fields", () => {
    const proposal = new StrategyProposal({ sendTelegram: async () => {}, autoApproveConvictionMin: 0.95 });
    const msg = proposal.formatMessage({
      id: "abc-123",
      name: "three-candle+day-phase-hybrid",
      type: "compose",
      conviction: 0.80,
      scores: { backtest: 0.85, paper: 0.82, live: 0.81 },
      evidence: { bt: { trades: 120 }, pt: { trades: 35 }, lt: { trades: 22 } },
      regime: "HOT",
      reason: "Day phase + three candle synergy detected in HOT regime",
    });
    expect(msg).toMatch("[PROPOSAL]");
    expect(msg).toMatch("three-candle+day-phase-hybrid");
    expect(msg).toMatch("85%");
    expect(msg).toMatch("/approve_abc-123");
    expect(msg).toMatch("/reject_abc-123");
  });

  it("auto-approves when conviction >= threshold and all gates >= 90%", async () => {
    const sendTelegram = vi.fn(async () => {});
    const proposal = new StrategyProposal({ sendTelegram, autoApproveConvictionMin: 0.95 });
    const result = await proposal.submit({
      id: "auto-001",
      name: "auto-strat",
      type: "select",
      conviction: 0.97,
      scores: { backtest: 0.92, paper: 0.91, live: 0.93 },
      evidence: {},
      regime: "HOT",
      reason: "high conviction, all gates >= 90%",
    });
    expect(result.autoApproved).toBe(true);
    expect(result.status).toBe("approved");
    expect(sendTelegram).toHaveBeenCalledWith(expect.stringMatching("AUTO-APPROVED"));
  });

  it("does NOT auto-approve when conviction below threshold", async () => {
    const sendTelegram = vi.fn(async () => {});
    const proposal = new StrategyProposal({ sendTelegram, autoApproveConvictionMin: 0.95, proposalTimeoutMs: 50 });
    const result = await proposal.submit({
      id: "manual-001",
      name: "manual-strat",
      type: "select",
      conviction: 0.80,
      scores: { backtest: 0.85, paper: 0.82, live: 0.81 },
      evidence: {},
      regime: "COLD",
      reason: "moderate conviction",
    });
    expect(result.autoApproved).toBe(false);
    expect(result.status).toBe("timeout_rejected");
  });

  it("handleOperatorResponse resolves pending promise with approved=true", async () => {
    const sendTelegram = vi.fn(async () => {});
    const proposal = new StrategyProposal({ sendTelegram, autoApproveConvictionMin: 0.95, proposalTimeoutMs: 5000 });
    const submitPromise = proposal.submit({
      id: "op-001",
      name: "op-strat",
      type: "select",
      conviction: 0.80,
      scores: { backtest: 0.85, paper: 0.82, live: 0.81 },
      evidence: {},
      regime: "HOT",
      reason: "waiting for operator",
    });
    await new Promise(r => setTimeout(r, 10));
    const handled = proposal.handleOperatorResponse("op-001", true);
    const result = await submitPromise;
    expect(handled).toBe(true);
    expect(result.status).toBe("approved");
  });
});
