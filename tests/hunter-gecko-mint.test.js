// Regression test for the GeckoTerminal mint-prefix bug. GeckoTerminal v2
// returns base-token ids network-prefixed ("solana_<mint>"). The hunter used
// that prefixed id as token.mint, so every downstream mint-keyed call 400'd —
// most visibly RugCheck (L0 of the rug defense) returning HTTP 400 for ~59%
// of candidates. geckoMintFromId strips the prefix so the bare base58 mint
// reaches RugCheck/Helius/on-chain lookups.

import { describe, it, expect } from "vitest";
import { geckoMintFromId } from "../tools/hunter-agent.js";

const WSOL = "So11111111111111111111111111111111111111112";

describe("geckoMintFromId — strip GeckoTerminal network prefix", () => {
  it("strips the solana_ prefix to the bare base58 mint", () => {
    expect(geckoMintFromId(`solana_${WSOL}`)).toBe(WSOL);
  });

  it("strips arbitrary network prefixes (only the first underscore)", () => {
    expect(geckoMintFromId("eth_0xabc123")).toBe("0xabc123");
    // base58 never contains '_', so the first underscore is always the
    // network delimiter — slicing there is safe.
    expect(geckoMintFromId(`solana_${WSOL}`)).not.toContain("_");
  });

  it("returns an already-bare mint unchanged", () => {
    expect(geckoMintFromId(WSOL)).toBe(WSOL);
  });

  it("returns null for empty / missing / non-string ids", () => {
    expect(geckoMintFromId("")).toBeNull();
    expect(geckoMintFromId(null)).toBeNull();
    expect(geckoMintFromId(undefined)).toBeNull();
    expect(geckoMintFromId(12345)).toBeNull();
  });

  it("returns null for a dangling prefix with no mint after it", () => {
    expect(geckoMintFromId("solana_")).toBeNull();
  });

  it("output never carries the prefix that caused RugCheck 400s", () => {
    const out = geckoMintFromId(`solana_${WSOL}`);
    expect(out.startsWith("solana_")).toBe(false);
  });
});
