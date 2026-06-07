import { describe, it, expect } from "vitest";
import { selectKellyMode, KELLY_MODES } from "../kelly-mode-selector.js";

describe("selectKellyMode", () => {
  it("returns CONSERVATIVE when liveTrades < 20", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 2, maxPositions: 3,
      winRate: 0.85, liveTrades: 10, conviction: 0.9, mode3Approved: false });
    expect(r.mode).toBe(KELLY_MODES.CONSERVATIVE);
    expect(r.effectiveBankroll).toBeCloseTo(10 / 3, 4);
  });

  it("returns CONSERVATIVE when winRate < 0.80", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 2, maxPositions: 3,
      winRate: 0.70, liveTrades: 30, conviction: 0.9, mode3Approved: false });
    expect(r.mode).toBe(KELLY_MODES.CONSERVATIVE);
  });

  it("returns ADAPTIVE when winRate 80-90% and trades >= 20 and conviction >= 0.70", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 2, maxPositions: 3,
      winRate: 0.85, liveTrades: 25, conviction: 0.75, mode3Approved: false });
    expect(r.mode).toBe(KELLY_MODES.ADAPTIVE);
    expect(r.effectiveBankroll).toBeCloseTo(10 - 2, 4);
  });

  it("returns ADAPTIVE (not FULL_KELLY) when mode3 criteria met but liveTrades < 50", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 0, maxPositions: 3,
      winRate: 1.0, liveTrades: 30, conviction: 0.99, mode3Approved: true,
      semanticMemoryEntries: 210 });
    expect(r.mode).toBe(KELLY_MODES.ADAPTIVE);
  });

  it("returns FULL_KELLY when all criteria met + mode3Approved=true", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 3, maxPositions: 3,
      winRate: 1.0, liveTrades: 55, conviction: 0.99, mode3Approved: true,
      semanticMemoryEntries: 210 });
    expect(r.mode).toBe(KELLY_MODES.FULL_KELLY);
    expect(r.effectiveBankroll).toBe(7);
  });

  it("returns ADAPTIVE (not FULL_KELLY) when mode3Approved=false even if all other criteria met", () => {
    const r = selectKellyMode({ bankrollSol: 10, deployedSol: 1, maxPositions: 3,
      winRate: 1.0, liveTrades: 55, conviction: 0.99, mode3Approved: false,
      semanticMemoryEntries: 210 });
    expect(r.mode).toBe(KELLY_MODES.ADAPTIVE);
  });
});
