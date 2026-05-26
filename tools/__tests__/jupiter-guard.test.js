import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preSwapGuard } from "../jupiter.js";
import { applyFeeEntryGuard } from "../solana-rpc.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("preSwapGuard", () => {
  it("blocks tokens that are not tradeable on Jupiter", async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 404 });

    const result = await preSwapGuard({ mint: "mint-not-tradeable", amountSol: 0.01 });

    expect(result).toEqual({
      allowed: false,
      reason: "not_tradeable: HTTP 404",
    });
  });

  it("blocks tokens with price impact above 15%", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        priceImpactPct: "16.5",
        outAmount: "1000",
        routePlan: [{}],
      })),
    });

    const result = await preSwapGuard({ mint: "mint-high-impact", amountSol: 0.01 });

    expect(result).toEqual({
      allowed: false,
      reason: "price_impact_too_high: 16.5%",
    });
  });

  it("allows tokens with acceptable price impact", async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({
        priceImpactPct: "4.25",
        outAmount: "1000",
        routePlan: [{}],
      })),
    });

    const result = await preSwapGuard({ mint: "mint-ok", amountSol: 0.01 });

    expect(result).toEqual({ allowed: true });
  });

  it("fails closed when the quote check fails", async () => {
    globalThis.fetch.mockRejectedValue(new Error("timeout"));

    const result = await preSwapGuard({ mint: "mint-timeout", amountSol: 0.01 });

    expect(result).toEqual({
      allowed: false,
      reason: "quote_check_failed",
    });
  });
});

describe("fee entry guard", () => {
  it("skips candidates for the cycle when gas fee level is extreme", () => {
    const candidates = [{ mint: "mint-1" }, { mint: "mint-2" }];

    expect(applyFeeEntryGuard(candidates, { level: "extreme" })).toEqual([]);
    expect(applyFeeEntryGuard(candidates, { level: "high" })).toBe(candidates);
  });
});
