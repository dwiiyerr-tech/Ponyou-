import { beforeEach, describe, expect, it } from "vitest";
import { trackPosition, _resetStateForTests } from "../state.js";
import { planWalletExecution } from "../wallet-strategy.js";

const wallets = [
  { address: "walletA", label: "A", status: "hot" },
  { address: "walletB", label: "B", status: "hot" },
  { address: "walletC", label: "C", status: "cold" },
];

beforeEach(() => {
  _resetStateForTests();
});

describe("planWalletExecution", () => {
  it("stays single-wallet for normal entry size", () => {
    const plan = planWalletExecution({
      wallets,
      tokenMint: "mintA",
      amountSol: 1.2,
      mode: "entry",
      maxWallets: 2,
      splitThresholdSol: 5,
    });

    expect(plan.split).toBe(false);
    expect(plan.selected_wallets).toHaveLength(1);
    expect(plan.selected_wallets[0].address).toBe("walletA");
    expect(plan.selected_wallets[0].amount_sol).toBe(1.2);
  });

  it("splits entry across hot wallets when size is large enough", () => {
    const plan = planWalletExecution({
      wallets,
      tokenMint: "mintA",
      amountSol: 6,
      mode: "entry",
      maxWallets: 2,
      splitThresholdSol: 5,
    });

    expect(plan.split).toBe(true);
    expect(plan.selected_wallets).toHaveLength(2);
    expect(plan.selected_wallets.map(w => w.address)).toEqual(["walletA", "walletB"]);
    expect(plan.selected_wallets[0].amount_sol).toBe(3);
    expect(plan.selected_wallets[1].amount_sol).toBe(3);
  });

  it("uses a fresh wallet for DCA when an existing wallet already holds the token", async () => {
    await trackPosition({
      position: "mintDca",
      pool: "gmgn",
      pool_name: "AAA",
      amount_sol: 1,
      initial_value_usd: 10,
      wallet_address: "walletA",
    });

    const plan = planWalletExecution({
      wallets,
      tokenMint: "mintDca",
      amountSol: 1,
      mode: "dca",
      maxWallets: 2,
      splitThresholdSol: 5,
    });

    expect(plan.selected_wallets).toHaveLength(1);
    expect(plan.selected_wallets[0].address).toBe("walletB");
    expect(plan.selected_wallets[0].has_position).toBe(false);
  });

  it("sells from the wallet that actually holds the token", async () => {
    await trackPosition({
      position: "mintSell",
      pool: "gmgn",
      pool_name: "AAA",
      amount_sol: 1,
      initial_value_usd: 10,
      wallet_address: "walletB",
    });

    const plan = planWalletExecution({
      wallets,
      tokenMint: "mintSell",
      amountSol: 1,
      mode: "sell",
      maxWallets: 2,
      splitThresholdSol: 5,
    });

    expect(plan.selected_wallets).toHaveLength(1);
    expect(plan.selected_wallets[0].address).toBe("walletB");
    expect(plan.selected_wallets[0].has_position).toBe(true);
  });
});
