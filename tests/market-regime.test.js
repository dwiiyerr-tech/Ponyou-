import { describe, expect, it } from "vitest";
import { REGIMES, normalizeRegime, isActiveRegime, isTradingAllowed, ALL_REGIMES } from "../market-regime.js";

describe("market-regime", () => {
  it("normalizes known regimes", () => {
    expect(normalizeRegime("hot")).toBe("HOT");
    expect(normalizeRegime("COLD")).toBe("COLD");
    expect(normalizeRegime("extreme")).toBe("EXTREME");
    expect(normalizeRegime("DEAD")).toBe("DEAD");
  });

  it("falls back to NORMAL for unknown values", () => {
    expect(normalizeRegime("UNKNOWN")).toBe("NORMAL");
    expect(normalizeRegime("")).toBe("NORMAL");
    expect(normalizeRegime(null)).toBe("NORMAL");
    expect(normalizeRegime(undefined)).toBe("NORMAL");
    expect(normalizeRegime("weird")).toBe("NORMAL");
  });

  it("isActiveRegime: HOT, WARM, NORMAL are active", () => {
    expect(isActiveRegime("HOT")).toBe(true);
    expect(isActiveRegime("WARM")).toBe(true);
    expect(isActiveRegime("NORMAL")).toBe(true);
    expect(isActiveRegime("COLD")).toBe(false);
    expect(isActiveRegime("DEAD")).toBe(false);
    expect(isActiveRegime("EXTREME")).toBe(false);
  });

  it("isTradingAllowed: DEAD and EXTREME blocked", () => {
    expect(isTradingAllowed("HOT")).toBe(true);
    expect(isTradingAllowed("WARM")).toBe(true);
    expect(isTradingAllowed("NORMAL")).toBe(true);
    expect(isTradingAllowed("COLD")).toBe(true);
    expect(isTradingAllowed("DEAD")).toBe(false);
    expect(isTradingAllowed("EXTREME")).toBe(false);
  });

  it("ALL_REGIMES contains all 6 values", () => {
    expect(ALL_REGIMES.size).toBe(6);
    for (const r of Object.values(REGIMES)) {
      expect(ALL_REGIMES.has(r)).toBe(true);
    }
  });
});
