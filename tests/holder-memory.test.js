import { describe, expect, it } from "vitest";
import { analyzeHolderStructure, getHolderMemoryRules } from "../holder-memory.js";

describe("getHolderMemoryRules", () => {
  it("returns structural holder heuristics for the prompt", () => {
    const rules = getHolderMemoryRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join(" ")).toMatch(/multi-wallet|same-funder|holder/i);
  });
});

describe("analyzeHolderStructure", () => {
  it("flags disguised coordination as high risk even if wallets look split", () => {
    const result = analyzeHolderStructure({
      rugSignals: {
        top10_concentration_pct: 48,
        same_funder_holders: 5,
        bundle_buyers_pct: 38,
        fresh_funded_holders: 6,
        dust_holders: 4,
      },
      holders: [{ pct: 2.1 }, { pct: 2.0 }, { pct: 1.8 }],
      token: { mcap: 120_000, hot_level: 0, narrative_tags: [] },
    });

    expect(result.hidden_wallet_control_score).toBeGreaterThanOrEqual(70);
    expect(result.holder_structure_risk).toBe("HIGH");
  });

  it("allows stronger concentration context on bigger narrative tokens", () => {
    const result = analyzeHolderStructure({
      rugSignals: {
        top10_concentration_pct: 68,
        same_funder_holders: 1,
        bundle_buyers_pct: 8,
        fresh_funded_holders: 1,
        dust_holders: 1,
      },
      holders: [{ pct: 8.5 }, { pct: 7.1 }],
      token: { mcap: 2_500_000, hot_level: 2, narrative_tags: ["AI", "CULTURE"] },
    });

    expect(result.context_allows_concentration).toBe(true);
    expect(result.holder_structure_risk).not.toBe("HIGH");
  });
});
