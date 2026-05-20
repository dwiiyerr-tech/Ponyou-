import { describe, expect, it } from "vitest";
import { scoreRugRisk } from "../lessons.js";
import { detectBundledLaunch } from "../tools/rug-signals.js";

describe("detectBundledLaunch", () => {
  it("detects one funder seeding more than five holders within the creation window", () => {
    const baseTs = Date.parse("2026-05-20T00:00:00.000Z");
    const holders = Array.from({ length: 6 }, (_, i) => ({
      address: `holder-${i}`,
      balance: 10,
      funded_by: "funder-a",
      funded_at: baseTs + i * 60_000,
    }));

    const result = detectBundledLaunch({ holders });

    expect(result.bundled).toBe(true);
    expect(result.bundled_score).toBe(6);
  });

  it("does not flag holders funded by different wallets", () => {
    const baseTs = Date.parse("2026-05-20T00:00:00.000Z");
    const holders = Array.from({ length: 6 }, (_, i) => ({
      address: `holder-${i}`,
      balance: 10,
      funded_by: `funder-${i}`,
      funded_at: baseTs,
    }));

    const result = detectBundledLaunch({ holders });

    expect(result.bundled).toBe(false);
    expect(result.bundled_score).toBe(1);
  });

  it("detects top-20 supply concentration above 60%", () => {
    const holders = [
      ...Array.from({ length: 20 }, (_, i) => ({ address: `top-${i}`, balance: 4 })),
      ...Array.from({ length: 20 }, (_, i) => ({ address: `tail-${i}`, balance: 1 })),
    ];

    const result = detectBundledLaunch({ holders });

    expect(result.supply_concentrated).toBe(true);
    expect(result.top20_pct).toBe(80);
  });

  it("adds bundled launch signals to rug risk scoring", () => {
    const result = scoreRugRisk({
      mint: "bundled-launch-mint",
      rug_signals: {
        bundled: true,
        bundled_score: 6,
        supply_concentrated: true,
        top20_pct: 80,
      },
    });

    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.reasons.join(" ")).toMatch(/bundled/i);
    expect(result.reasons.join(" ")).toMatch(/top20/i);
  });
});
