import { describe, expect, it } from "vitest";
import { applyScoreDecay } from "../tools/wallet-discovery.js";

const NOW = Date.parse("2026-05-20T00:00:00.000Z");
const daysAgo = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function wallet(lastActive) {
  return {
    address: "wallet-a",
    score: 100,
    selection: { score: 100 },
    last_active: lastActive,
  };
}

describe("applyScoreDecay", () => {
  it("keeps full score for wallets active within 7 days", () => {
    expect(applyScoreDecay(wallet(daysAgo(3)), NOW).score).toBe(100);
  });

  it("applies 0.8 multiplier for wallets inactive 7-30 days", () => {
    expect(applyScoreDecay(wallet(daysAgo(14)), NOW).score).toBe(80);
  });

  it("applies 0.5 multiplier for wallets inactive 30-90 days", () => {
    expect(applyScoreDecay(wallet(daysAgo(45)), NOW).score).toBe(50);
  });

  it("applies 0.2 multiplier for wallets inactive more than 90 days", () => {
    expect(applyScoreDecay(wallet(daysAgo(120)), NOW).score).toBe(20);
  });
});
