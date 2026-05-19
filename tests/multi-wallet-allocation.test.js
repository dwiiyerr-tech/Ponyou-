import { describe, expect, it } from "vitest";
import { analyzeCapitalAwareWalletPlan } from "../multi-wallet-allocation.js";

const wallets = [
  { address: "A", label: "A", capital_pct: 50, status: "hot", is_active: true },
  { address: "B", label: "B", capital_pct: 30, status: "hot", is_active: false },
  { address: "C", label: "C", capital_pct: 20, status: "cold", is_active: false },
];

describe("analyzeCapitalAwareWalletPlan", () => {
  it("stays single-wallet when capital is not enough to spread", () => {
    const plan = analyzeCapitalAwareWalletPlan({
      wallets,
      totalSol: 1.2,
      desiredAmountSol: 0.4,
      reserveSol: 0.2,
      maxEntries: 2,
      minTotalSol: 3,
      minWalletDeploySol: 0.25,
    });

    expect(plan.spread_ready).toBe(false);
    expect(plan.selected_wallets).toHaveLength(1);
    expect(plan.selected_wallets[0].address).toBe("A");
  });

  it("spreads across multiple hot wallets when capital is sufficient", () => {
    const plan = analyzeCapitalAwareWalletPlan({
      wallets,
      totalSol: 6,
      desiredAmountSol: 0.6,
      reserveSol: 0.2,
      maxEntries: 2,
      minTotalSol: 3,
      minWalletDeploySol: 0.25,
    });

    expect(plan.spread_ready).toBe(true);
    expect(plan.selected_wallets).toHaveLength(2);
    expect(plan.selected_wallets.map(w => w.address)).toEqual(["A", "B"]);
  });
});
