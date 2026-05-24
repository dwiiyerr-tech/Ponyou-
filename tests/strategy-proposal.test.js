import { describe, it, expect, vi } from "vitest";
import { StrategyProposal, escalationBar } from "../strategy-proposal.js";

const matureEvidence = (extra = {}) => ({
  fundamental: {
    maturity: { ageDays: 60, oldestSeenAt: new Date(Date.now() - 60 * 86400 * 1000).toISOString() },
    sources: ["regime", "conviction"],
    scores: { composite_strength: 78 },
    sampledMints: ["MintA", "MintB"],
    sampledWallets: ["W1"],
  },
  ...extra,
});

describe("StrategyProposal", () => {
  it("formats proposal message with all evidence fields", () => {
    const proposal = new StrategyProposal({ sendTelegram: async () => {}, autoApproveConvictionMin: 0.95 });
    const msg = proposal.formatMessage({
      id: "abc-123",
      name: "three-candle+day-phase-hybrid",
      type: "compose",
      conviction: 0.80,
      scores: { backtest: 0.85, paper: 0.82, live: 0.81 },
      evidence: { backtest: { trades: 120 }, paper: { trades: 35 }, live: { trades: 22 } },
      regime: "HOT",
      reason: "Day phase + three candle synergy detected in HOT regime",
    });
    expect(msg).toMatch("[PROPOSAL]");
    expect(msg).toMatch("three-candle+day-phase-hybrid");
    expect(msg).toMatch("85%");
    expect(msg).toMatch("/approve_abc-123");
    expect(msg).toMatch("/reject_abc-123");
  });

  it("renders 80→100% escalation bars in the message", () => {
    const proposal = new StrategyProposal({ sendTelegram: async () => {} });
    const msg = proposal.formatMessage({
      id: "bar-1",
      name: "bar-strat",
      type: "compose",
      conviction: 0.85,
      scores: { backtest: 1.0, paper: 0.5, live: 0.0 },
      evidence: {},
      regime: "HOT",
    });
    // The full-bar (100%) renders 10 filled blocks; 0% renders 10 empty.
    expect(msg).toMatch(/Backtest:\s+█{10}\s+100%/);
    expect(msg).toMatch(/Live:\s+□{10}\s+0%/);
  });

  it("includes fundamental evidence when present", () => {
    const proposal = new StrategyProposal({ sendTelegram: async () => {} });
    const msg = proposal.formatMessage({
      id: "fund-1",
      name: "fund-strat",
      type: "compose",
      conviction: 0.80,
      scores: { backtest: 0.85, paper: 0.85, live: 0.82 },
      evidence: matureEvidence({ backtest: { trades: 100 }, paper: { trades: 30 }, live: { trades: 20 } }),
      regime: "HOT",
    });
    expect(msg).toMatch("Composite strength");
    expect(msg).toMatch("Sampled mints:");
    expect(msg).toMatch(/Data maturity:\s+60\.0d/);
  });

  it("flags young agent data with ⚠ in proposal", () => {
    const proposal = new StrategyProposal({
      sendTelegram: async () => {},
      autoApproveMinMaturityDays: 30,
    });
    const youngEvidence = {
      fundamental: {
        maturity: { ageDays: 5 },
        sources: ["regime"],
        scores: { composite_strength: 70 },
        sampledMints: [], sampledWallets: [],
      },
    };
    const msg = proposal.formatMessage({
      id: "young-1",
      name: "young-strat",
      type: "compose",
      conviction: 0.80,
      scores: { backtest: 0.85, paper: 0.82, live: 0.81 },
      evidence: youngEvidence,
      regime: "HOT",
    });
    expect(msg).toMatch(/⚠ below auto-approve threshold/);
  });

  it("auto-approves when conviction >= threshold, all gates >= 90%, AND maturity ok", async () => {
    const sendTelegram = vi.fn(async () => {});
    const proposal = new StrategyProposal({
      sendTelegram,
      autoApproveConvictionMin: 0.95,
      autoApproveMinMaturityDays: 30,
    });
    const result = await proposal.submit({
      id: "auto-001",
      name: "auto-strat",
      type: "select",
      conviction: 0.97,
      scores: { backtest: 0.92, paper: 0.91, live: 0.93 },
      evidence: matureEvidence(),
      regime: "HOT",
      reason: "mature, high conviction, all gates >= 90%",
    });
    expect(result.autoApproved).toBe(true);
    expect(result.status).toBe("approved");
    expect(result.decision.maturityPasses).toBe(true);
    expect(sendTelegram).toHaveBeenCalledWith(expect.stringMatching("AUTO-APPROVED"));
  });

  it("REFUSES auto-approve when conviction high but data immature", async () => {
    const sendTelegram = vi.fn(async () => {});
    const proposal = new StrategyProposal({
      sendTelegram,
      autoApproveConvictionMin: 0.95,
      autoApproveMinMaturityDays: 30,
      proposalTimeoutMs: 50,
    });
    const result = await proposal.submit({
      id: "young-002",
      name: "young-strat",
      type: "compose",
      conviction: 0.99,
      scores: { backtest: 0.95, paper: 0.92, live: 0.91 },
      evidence: {
        fundamental: { maturity: { ageDays: 7 }, sources: [], scores: {}, sampledMints: [], sampledWallets: [] },
      },
      regime: "HOT",
      reason: "young but strong — needs operator sign-off",
    });
    expect(result.autoApproved).toBe(false);
    expect(result.status).toBe("timeout_rejected");
    expect(result.decision.maturityPasses).toBe(false);
  });

  it("does NOT auto-approve when conviction below threshold", async () => {
    const sendTelegram = vi.fn(async () => {});
    const proposal = new StrategyProposal({
      sendTelegram,
      autoApproveConvictionMin: 0.95,
      autoApproveMinMaturityDays: 0,
      proposalTimeoutMs: 50,
    });
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
    const proposal = new StrategyProposal({
      sendTelegram,
      autoApproveConvictionMin: 0.95,
      autoApproveMinMaturityDays: 0,
      proposalTimeoutMs: 5000,
    });
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

describe("escalationBar", () => {
  it("renders proportional fills for each gate", () => {
    const bars = escalationBar({ backtest: 0.5, paper: 1.0, live: 0 });
    expect(bars.backtest).toBe("█".repeat(5) + "□".repeat(5));
    expect(bars.paper).toBe("█".repeat(10));
    expect(bars.live).toBe("□".repeat(10));
  });

  it("clamps out-of-range values to 0..1", () => {
    const bars = escalationBar({ backtest: 1.5, paper: -0.2, live: 0.85 });
    expect(bars.backtest).toBe("█".repeat(10));
    expect(bars.paper).toBe("□".repeat(10));
    expect(bars.live).toBe("█".repeat(9) + "□".repeat(1));
  });
});
