import { describe, expect, it } from "vitest";
import { validateWalletTopology } from "../wallet-topology.js";

describe("wallet topology", () => {
  it("passes a valid multi-wallet allocation", () => {
    const topology = validateWalletTopology({
      enabled: true,
      wallets: [
        { label: "A", key: "key-a", capital_pct: 60 },
        { label: "B", key: "key-b", capital_pct: 40 },
      ],
    });

    expect(topology.ok).toBe(true);
    expect(topology.total_capital_pct).toBe(100);
  });

  it("rejects duplicate labels and invalid capital splits", () => {
    const topology = validateWalletTopology({
      enabled: true,
      wallets: [
        { label: "A", key: "key-a", capital_pct: 70 },
        { label: "A", key: "key-b", capital_pct: 20 },
      ],
    });

    expect(topology.ok).toBe(false);
    expect(topology.errors.some((e) => e.includes("Duplicate wallet label"))).toBe(true);
    expect(topology.errors.some((e) => e.includes("sum to 100%"))).toBe(true);
  });

  it("rejects enabled multi-wallet with fewer than two wallets", () => {
    const topology = validateWalletTopology({
      enabled: true,
      wallets: [{ label: "Solo", key: "key-a", capital_pct: 100 }],
    });

    expect(topology.ok).toBe(false);
    expect(topology.errors.some((e) => e.includes("at least 2 wallets"))).toBe(true);
  });
});
