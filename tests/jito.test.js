import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  pickTipAccount,
  getJitoEndpoint,
  isJitoEnabled,
  validateJitoConfig,
  buildTipTransaction,
  serializeTxForBundle,
  _internal,
} from "../tools/jito.js";

describe("pickTipAccount", () => {
  it("returns a PublicKey from the published set", () => {
    const pk = pickTipAccount();
    expect(pk).toBeInstanceOf(PublicKey);
    expect(_internal.TIP_ACCOUNTS).toContain(pk.toString());
  });

  it("varies across calls (probabilistic — fails ~1 in 10^9)", () => {
    const samples = new Set();
    for (let i = 0; i < 100; i++) samples.add(pickTipAccount().toString());
    // 8 accounts, 100 picks — should hit at least 4 distinct ones unless RNG is broken
    expect(samples.size).toBeGreaterThanOrEqual(4);
  });
});

describe("getJitoEndpoint", () => {
  it.each([
    ["fra", "frankfurt"],
    ["ny",  "ny.mainnet"],
    ["ams", "amsterdam"],
    ["tyo", "tokyo"],
  ])("region %s returns endpoint containing %s", (region, fragment) => {
    expect(getJitoEndpoint(region)).toContain(fragment);
  });

  it("unknown region falls back to fra", () => {
    expect(getJitoEndpoint("ghost")).toBe(getJitoEndpoint("fra"));
  });
});

describe("isJitoEnabled", () => {
  it("returns false when disabled", () => {
    expect(isJitoEnabled({ jito: { enabled: false, tipLamports: 1000 } })).toBe(false);
  });

  it("returns false without tipLamports", () => {
    expect(isJitoEnabled({ jito: { enabled: true } })).toBe(false);
  });

  it("returns false for non-positive tip", () => {
    expect(isJitoEnabled({ jito: { enabled: true, tipLamports: 0 } })).toBe(false);
    expect(isJitoEnabled({ jito: { enabled: true, tipLamports: -1 } })).toBe(false);
  });

  it("returns true when enabled + tip > 0", () => {
    expect(isJitoEnabled({ jito: { enabled: true, tipLamports: 100000 } })).toBe(true);
  });

  it("handles missing jito block", () => {
    expect(isJitoEnabled({})).toBe(false);
    expect(isJitoEnabled(null)).toBe(false);
  });
});

describe("validateJitoConfig", () => {
  it("disabled = trivially valid", () => {
    const r = validateJitoConfig({ jito: { enabled: false } });
    expect(r.valid).toBe(true);
    expect(r.enabled).toBe(false);
  });

  it("flags bad tipLamports", () => {
    const r = validateJitoConfig({ jito: { enabled: true, tipLamports: -1 } });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/tipLamports/);
  });

  it("flags bad region", () => {
    const r = validateJitoConfig({ jito: { enabled: true, tipLamports: 100, region: "moon" } });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /region/.test(e))).toBe(true);
  });

  it("happy path", () => {
    const r = validateJitoConfig({ jito: { enabled: true, tipLamports: 100000, region: "fra" } });
    expect(r.valid).toBe(true);
  });
});

describe("buildTipTransaction", () => {
  const wallet = Keypair.generate();
  const blockhash = "11111111111111111111111111111111";

  it("builds a signed tx with one transfer instruction", () => {
    const tx = buildTipTransaction({
      wallet,
      recentBlockhash: blockhash,
      tipLamports: 100_000,
    });
    expect(tx.instructions).toHaveLength(1);
    expect(tx.feePayer.toString()).toBe(wallet.publicKey.toString());
    expect(tx.recentBlockhash).toBe(blockhash);
    expect(tx.signatures.length).toBeGreaterThan(0);
  });

  it("uses provided tipAccount when given", () => {
    const tipAcct = new PublicKey(_internal.TIP_ACCOUNTS[3]);
    const tx = buildTipTransaction({
      wallet,
      recentBlockhash: blockhash,
      tipLamports: 1000,
      tipAccount: tipAcct,
    });
    // The transfer ix's destination should match tipAcct
    const keys = tx.instructions[0].keys;
    expect(keys[1].pubkey.toString()).toBe(tipAcct.toString());
  });

  it("rejects missing inputs", () => {
    expect(() => buildTipTransaction({ recentBlockhash: blockhash, tipLamports: 1000 })).toThrow();
    expect(() => buildTipTransaction({ wallet, tipLamports: 1000 })).toThrow();
    expect(() => buildTipTransaction({ wallet, recentBlockhash: blockhash, tipLamports: 0 })).toThrow();
  });
});

describe("serializeTxForBundle", () => {
  it("produces a base58 string from a signed tx", () => {
    const wallet = Keypair.generate();
    const tx = buildTipTransaction({
      wallet,
      recentBlockhash: "11111111111111111111111111111111",
      tipLamports: 1000,
    });
    const b58 = serializeTxForBundle(tx);
    expect(typeof b58).toBe("string");
    expect(b58.length).toBeGreaterThan(0);
    // base58 alphabet — no 0, O, I, l
    expect(b58).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("throws on missing tx", () => {
    expect(() => serializeTxForBundle(null)).toThrow();
  });
});
