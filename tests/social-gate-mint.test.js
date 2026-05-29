// Regression test for the social-gate mint filter (L1b). Social signals are
// consumed as a symbol-keyed buzz score, but a signal carrying a non-Solana
// or malformed mint (EVM "0x…", network-prefixed "solana_…", garbage) is pure
// noise / a symbol-collision risk. The gate now drops those, while symbol-only
// sources (coingecko trending) that legitimately carry no mint still pass.

import { describe, it, expect } from "vitest";
import { gateSignal, isLikelySolanaMint } from "../social-trash-gate.js";

const SOL_MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"; // WIF
const WSOL = "So11111111111111111111111111111111111111112";

describe("isLikelySolanaMint", () => {
  it("accepts valid base58 Solana mints", () => {
    expect(isLikelySolanaMint(SOL_MINT)).toBe(true);
    expect(isLikelySolanaMint(WSOL)).toBe(true);
  });
  it("rejects EVM addresses", () => {
    expect(isLikelySolanaMint("0x6b175474e89094c44da98b954eedeac495271d0f")).toBe(false);
  });
  it("rejects network-prefixed / underscored ids", () => {
    expect(isLikelySolanaMint(`solana_${WSOL}`)).toBe(false);
  });
  it("rejects garbage / wrong length / non-strings", () => {
    expect(isLikelySolanaMint("short")).toBe(false);
    expect(isLikelySolanaMint("")).toBe(false);
    expect(isLikelySolanaMint(null)).toBe(false);
    expect(isLikelySolanaMint(12345)).toBe(false);
  });
});

describe("gateSignal — L1b mint filter", () => {
  it("blocks a signal carrying an EVM (non-Solana) mint", () => {
    const r = gateSignal({ symbol: "SHIB", source: "telegram", mint: "0xdef1c0ded9bec7f1a1670819833240f027b25eff" });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("non_solana_mint");
  });

  it("blocks a signal whose mint is network-prefixed (solana_…)", () => {
    const r = gateSignal({ symbol: "PEPE", source: "discord", mint: `solana_${WSOL}` });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("non_solana_mint");
  });

  it("blocks a dexscreener signal that is missing its mint", () => {
    const r = gateSignal({ symbol: "MEME", source: "dexscreener", txns: 100 });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe("missing_mint");
  });

  it("lets a coingecko symbol-only signal through (mint-less is exempt)", () => {
    const r = gateSignal({ symbol: "BONK", source: "coingecko", rank: 3 });
    expect(r.pass).toBe(true);
  });

  it("lets a signal with a valid Solana mint through", () => {
    const r = gateSignal({ symbol: "WIF", source: "dexscreener", mint: SOL_MINT, txns: 100 });
    expect(r.pass).toBe(true);
  });
});
