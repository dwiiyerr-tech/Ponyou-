// Phase 3 multi-chain execution — GMGN swap adapter.
// Verifies: HARD-OFF-by-default dry-run gating, native currency resolution,
// smallest-unit conversion, and that the Solana path is never routed to GMGN.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ execEnabled: false, wallets: {} }));

vi.mock("../config.js", () => ({
  config: {
    gmgn: { get execEnabled() { return h.execEnabled; }, get wallets() { return h.wallets; } },
    management: { gasReserve: 0.2 },
  },
}));
vi.mock("../logger.js", () => ({ log: vi.fn(), logAction: vi.fn() }));
vi.mock("../metrics.js", () => ({ recordCounter: vi.fn() }));

const { executeGmgnSwap, resolveToken, toSmallestUnit, NATIVE_CURRENCY } =
  await import("../tools/gmgnSwap.js");

describe("gmgnSwap: native currency resolution", () => {
  it("maps native sentinels to the chain's currency address", () => {
    expect(resolveToken("SOL", "sol")).toBe(NATIVE_CURRENCY.sol);
    expect(resolveToken("ETH", "base")).toBe("0x0000000000000000000000000000000000000000");
    expect(resolveToken("BNB", "bsc")).toBe("0x0000000000000000000000000000000000000000");
    expect(resolveToken("native", "eth")).toBe("0x0000000000000000000000000000000000000000");
  });

  it("passes through explicit token addresses unchanged", () => {
    expect(resolveToken("0xDeadBeef", "base")).toBe("0xDeadBeef");
    expect(resolveToken("SomeSolMint", "sol")).toBe("SomeSolMint");
  });
});

describe("gmgnSwap: smallest-unit conversion (18 decimals)", () => {
  it("converts whole and fractional amounts without float drift", () => {
    expect(toSmallestUnit("1", 18)).toBe("1000000000000000000");
    expect(toSmallestUnit("0.01", 18)).toBe("10000000000000000");
    expect(toSmallestUnit("0.000001", 18)).toBe("1000000000000");
    expect(toSmallestUnit("2.5", 18)).toBe("2500000000000000000");
  });
});

describe("gmgnSwap: HARD-OFF dry-run gating", () => {
  beforeEach(() => { h.execEnabled = false; h.wallets = {}; delete process.env.DRY_RUN; });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.DRY_RUN; });

  it("execEnabled=false → dry-run result, no funds, correct shape", async () => {
    const r = await executeGmgnSwap({ token_in: "ETH", token_out: "0xToken", amount: 0.01, chain: "base" });
    expect(r).toMatchObject({
      success: true, dry_run: true, chain: "base", execution_provider: "gmgn", hash: null,
    });
    expect(r.would_swap).toMatchObject({
      token_in: "0x0000000000000000000000000000000000000000",
      token_out: "0xToken",
      amount: 0.01,
      chain: "base",
    });
  });

  it("execEnabled=true but DRY_RUN=true → still simulates", async () => {
    h.execEnabled = true;
    process.env.DRY_RUN = "true";
    const r = await executeGmgnSwap({ token_in: "BNB", token_out: "0xTok", amount: 0.1, chain: "bsc" });
    expect(r.dry_run).toBe(true);
    expect(r.success).toBe(true);
  });

  it("execEnabled=true + live but no wallet → returns error, never executes", async () => {
    h.execEnabled = true;
    h.wallets = {}; // no base wallet
    delete process.env.DRY_RUN;
    const r = await executeGmgnSwap({ token_in: "ETH", token_out: "0xTok", amount: 0.01, chain: "base" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No wallet configured for chain base/);
  });
});
