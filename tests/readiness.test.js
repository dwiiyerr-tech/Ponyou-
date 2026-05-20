import { describe, expect, it } from "vitest";
import { getOperationalReadiness } from "../readiness.js";

describe("getOperationalReadiness", () => {
  it("blocks live mode when critical trading prerequisites are missing", () => {
    const readiness = getOperationalReadiness({
      env: {
        EXECUTION_MODE: "live",
      },
      executionMode: { mode: "live" },
      runtime: {
        hasActiveWallet: false,
      },
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.errors).toContain("RPC_URL is not configured.");
    expect(readiness.errors).toContain("No trading wallet is configured.");
    expect(readiness.errors).toContain("HELIUS_API_KEY is missing.");
  });

  it("passes with the minimum live prerequisites and warns about optional safety rails", () => {
    const readiness = getOperationalReadiness({
      env: {
        EXECUTION_MODE: "live",
        RPC_URL: "https://rpc.example",
        HELIUS_API_KEY: "helius-key",
        SHYFT_API_KEY: "shyft-key",
        WALLET_PRIVATE_KEY: "wallet-key",
      },
      executionMode: { mode: "live" },
      runtime: {
        hasActiveWallet: true,
      },
      config: {
        management: { minSolToOpen: 1, gasReserve: 0.2 },
        trading: { confirmMode: false },
        multiWallet: { enabled: false, wallets: [] },
      },
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.warnings.some(w => w.includes("confirmMode is OFF"))).toBe(true);
    expect(readiness.warnings.some(w => w.includes("Telegram is not configured"))).toBe(true);
  });


  it("blocks live mode when multi-wallet topology is invalid", () => {
    const readiness = getOperationalReadiness({
      env: {
        EXECUTION_MODE: "live",
        RPC_URL: "https://rpc.example",
        HELIUS_API_KEY: "helius-key",
        SHYFT_API_KEY: "shyft-key",
        WALLET_PRIVATE_KEY: "wallet-key",
      },
      executionMode: { mode: "live" },
      runtime: {
        hasActiveWallet: true,
      },
      config: {
        management: { minSolToOpen: 1, gasReserve: 0.2 },
        trading: { confirmMode: true },
        multiWallet: {
          enabled: true,
          wallets: [{ label: "A", key: "key-a", capital_pct: 100 }],
        },
      },
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.errors.some((e) => e.includes("at least 2 wallets"))).toBe(true);
  });
  it("allows demo mode to proceed without live-only warnings", () => {
    const readiness = getOperationalReadiness({
      env: {
        EXECUTION_MODE: "demo",
        RPC_URL: "https://rpc.example",
        HELIUS_API_KEY: "helius-key",
        SHYFT_API_KEY: "shyft-key",
        WALLET_PRIVATE_KEY: "wallet-key",
      },
      executionMode: { mode: "demo" },
      runtime: {
        hasActiveWallet: true,
      },
      config: {
        management: { minSolToOpen: 1, gasReserve: 0.2 },
        trading: { confirmMode: false },
        multiWallet: { enabled: false, wallets: [] },
      },
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.warnings).toEqual([]);
  });

  it("warns when Shyft fallback provider is missing", () => {
    const readiness = getOperationalReadiness({
      env: {
        EXECUTION_MODE: "demo",
        RPC_URL: "https://rpc.example",
        HELIUS_API_KEY: "helius-key",
        WALLET_PRIVATE_KEY: "wallet-key",
      },
      executionMode: { mode: "demo" },
      runtime: {
        hasActiveWallet: true,
      },
      config: {
        management: { minSolToOpen: 1, gasReserve: 0.2 },
        trading: { confirmMode: false },
        multiWallet: { enabled: false, wallets: [] },
      },
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.warnings).toContain("SHYFT_API_KEY is missing. Helius fallback provider unavailable.");
  });
});
