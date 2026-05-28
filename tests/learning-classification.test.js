// LA-1: learning agent must classify LLM-closed rugs correctly. Previously
// only deterministic exits with reason="rug" were counted; LLM exits all
// carried reason="LLM Manager Decision" so rugs closed by the LLM were
// silently miscategorized as wins or losses depending on PnL — corrupting
// hunter-source ranking and rug-pattern learning input.
//
// This test isolates the classification logic by replicating the rule used
// in learning-agent.js (kept duplicated rather than refactored to keep the
// test self-contained and the agent change minimal).

import { describe, it, expect } from "vitest";

function classifyExit(payload) {
  const reasonStr = String(payload?.reason || "").toLowerCase();
  const pnlPct  = payload?.pnl_pct ?? payload?.pnl ?? 0;
  const isExplicitRug = !!payload?.rug_detected;
  const reasonHasRug  = /rug|honeypot|drained/.test(reasonStr);
  const isWipeout     = Number.isFinite(pnlPct) && pnlPct <= -80;
  const isRug = isExplicitRug || reasonHasRug || isWipeout;
  const isLoss  = !isRug && pnlPct < -15;
  const isWin   = !isRug && pnlPct > 0;
  return isRug ? "rug" : isLoss ? "loss" : isWin ? "win" : "neutral";
}

describe("classifyExit — LA-1 rug-detection across exit paths", () => {
  it("deterministic exit with reason 'rug' → rug", () => {
    expect(classifyExit({ reason: "rug", pnl_pct: -50 })).toBe("rug");
  });

  it("LLM exit with explicit rug_detected flag → rug", () => {
    expect(classifyExit({ reason: "LLM Manager Decision", rug_detected: true, pnl_pct: -30 })).toBe("rug");
  });

  it("LLM exit on wipeout (-90% PnL) → rug (no explicit flag needed)", () => {
    expect(classifyExit({ reason: "LLM Manager Decision", pnl_pct: -90 })).toBe("rug");
  });

  it("LLM exit on minor loss (-25% PnL) → loss, not rug", () => {
    expect(classifyExit({ reason: "LLM Manager Decision", pnl_pct: -25 })).toBe("loss");
  });

  it("LLM exit on win (+20% PnL) → win", () => {
    expect(classifyExit({ reason: "LLM Manager Decision", pnl_pct: 20 })).toBe("win");
  });

  it("reason containing 'honeypot' → rug (catches downstream rename)", () => {
    expect(classifyExit({ reason: "Detected honeypot", pnl_pct: -10 })).toBe("rug");
  });

  it("reason containing 'drained' → rug", () => {
    expect(classifyExit({ reason: "LP drained", pnl_pct: -50 })).toBe("rug");
  });

  it("neutral when PnL is zero and no rug signal", () => {
    expect(classifyExit({ reason: "Manual close", pnl_pct: 0 })).toBe("neutral");
  });

  it("missing payload → neutral", () => {
    expect(classifyExit({})).toBe("neutral");
  });

  it("exact threshold -80% PnL → rug (inclusive boundary)", () => {
    expect(classifyExit({ reason: "LLM Manager Decision", pnl_pct: -80 })).toBe("rug");
  });
});
