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

  it("accepts wallets configured via env_ref instead of inline key", () => {
    const topology = validateWalletTopology({
      enabled: true,
      wallets: [
        { label: "main",  env_ref: "WALLET_KEY_1", capital_pct: 60 },
        { label: "scout", env_ref: "WALLET_KEY_2", capital_pct: 40 },
      ],
    });
    expect(topology.ok).toBe(true);
    expect(topology.wallets[0].env_ref).toBe("WALLET_KEY_1");
  });

  it("rejects env_ref that does not match WALLET_KEY_1..10", () => {
    const topology = validateWalletTopology({
      enabled: true,
      wallets: [
        { label: "A", env_ref: "FOO_KEY",      capital_pct: 50 },
        { label: "B", env_ref: "WALLET_KEY_2", capital_pct: 50 },
      ],
    });
    expect(topology.ok).toBe(false);
    expect(topology.errors.some((e) => e.includes("WALLET_KEY_1..10"))).toBe(true);
  });

  it("rejects more than 10 wallets", () => {
    const wallets = Array.from({ length: 11 }, (_, i) => ({
      label: `w${i}`,
      env_ref: `WALLET_KEY_${(i % 10) + 1}`,
      capital_pct: 100 / 11,
    }));
    const topology = validateWalletTopology({ enabled: true, wallets });
    expect(topology.ok).toBe(false);
    expect(topology.errors.some((e) => e.includes("at most 10"))).toBe(true);
  });

  it("rejects two wallets that share the same env_ref", () => {
    const topology = validateWalletTopology({
      enabled: true,
      wallets: [
        { label: "A", env_ref: "WALLET_KEY_1", capital_pct: 50 },
        { label: "B", env_ref: "WALLET_KEY_1", capital_pct: 50 },
      ],
    });
    expect(topology.ok).toBe(false);
    expect(topology.errors.some((e) => e.includes("Duplicate wallet secret"))).toBe(true);
  });

  it("rejects wallet with neither key nor env_ref", () => {
    const topology = validateWalletTopology({
      enabled: true,
      wallets: [
        { label: "A", capital_pct: 50 },
        { label: "B", env_ref: "WALLET_KEY_2", capital_pct: 50 },
      ],
    });
    expect(topology.ok).toBe(false);
    expect(topology.errors.some((e) => e.includes("missing both key and env_ref"))).toBe(true);
  });
});
