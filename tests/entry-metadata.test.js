import { describe, expect, it, vi } from "vitest";
import { captureEntryMetadata } from "../tools/entry-metadata.js";

describe("captureEntryMetadata", () => {
  it("returns full metadata when all sources succeed", async () => {
    const fetchers = {
      getMintInfo: vi.fn().mockResolvedValue({
        creator: "Dep111111111111111111111111111111111111111",
        mint_authority: null,
        freeze_authority: null,
      }),
      getPoolInfo: vi.fn().mockResolvedValue({ pool_address: "Pool1111111111111111111111111111111111111111", lp_usd: 25000 }),
      getTopHolders: vi.fn().mockResolvedValue([
        { wallet: "W1", balance: 1000 },
        { wallet: "W2", balance: 500 },
      ]),
    };
    const meta = await captureEntryMetadata("MINT", fetchers);
    expect(meta.deployer_wallet).toBe("Dep111111111111111111111111111111111111111");
    expect(meta.lp_address).toBe("Pool1111111111111111111111111111111111111111");
    expect(meta.lp_usd_at_entry).toBe(25000);
    expect(meta.top_holders_snapshot).toHaveLength(2);
    expect(meta.authorities).toEqual({ mint_authority: null, freeze_authority: null });
    expect(meta.partial).toBe(false);
    expect(meta.mint).toBe("MINT");
  });

  it("marks partial=true when one fetcher fails", async () => {
    const fetchers = {
      getMintInfo: vi.fn().mockResolvedValue({ creator: "Dep", mint_authority: null, freeze_authority: null }),
      getPoolInfo: vi.fn().mockRejectedValue(new Error("pool not found")),
      getTopHolders: vi.fn().mockResolvedValue([]),
    };
    const meta = await captureEntryMetadata("MINT", fetchers);
    expect(meta.lp_address).toBeNull();
    expect(meta.partial).toBe(true);
    expect(meta.errors).toContain("pool_info_failed");
  });

  it("returns mint-only metadata if all fetchers fail", async () => {
    const fetchers = {
      getMintInfo: vi.fn().mockRejectedValue(new Error("rpc down")),
      getPoolInfo: vi.fn().mockRejectedValue(new Error("rpc down")),
      getTopHolders: vi.fn().mockRejectedValue(new Error("rpc down")),
    };
    const meta = await captureEntryMetadata("MINT", fetchers);
    expect(meta.mint).toBe("MINT");
    expect(meta.partial).toBe(true);
    expect(meta.errors).toHaveLength(3);
  });
});
