import { describe, it, expect } from "vitest";
import {
  parseTransactionEvent,
  diffTokenBalances,
  startGeyserStream,
} from "../geyser.js";

describe("diffTokenBalances", () => {
  it("identifies the mint that decreased and the one that increased", () => {
    const pre = [
      { mint: "SOL", owner: "A", uiTokenAmount: { uiAmount: 10 } },
      { mint: "BONK", owner: "A", uiTokenAmount: { uiAmount: 0 } },
    ];
    const post = [
      { mint: "SOL", owner: "A", uiTokenAmount: { uiAmount: 9 } },
      { mint: "BONK", owner: "A", uiTokenAmount: { uiAmount: 1000 } },
    ];
    const r = diffTokenBalances(pre, post, "A");
    expect(r.token_in).toBe("SOL");
    expect(r.token_out).toBe("BONK");
    expect(r.amount_in).toBeCloseTo(1);
    expect(r.amount_out).toBeCloseTo(1000);
  });

  it("returns nulls when no balance changes for the wallet", () => {
    const pre = [{ mint: "X", owner: "A", uiTokenAmount: { uiAmount: 5 } }];
    const post = [{ mint: "X", owner: "A", uiTokenAmount: { uiAmount: 5 } }];
    const r = diffTokenBalances(pre, post, "A");
    expect(r.token_in).toBeNull();
    expect(r.token_out).toBeNull();
  });

  it("respects ownerFilter (ignores other wallets)", () => {
    const pre = [
      { mint: "X", owner: "B", uiTokenAmount: { uiAmount: 10 } },
    ];
    const post = [
      { mint: "X", owner: "B", uiTokenAmount: { uiAmount: 1 } },
    ];
    const r = diffTokenBalances(pre, post, "A");
    expect(r.token_in).toBeNull();
    expect(r.token_out).toBeNull();
  });

  it("handles missing uiAmount safely", () => {
    const pre = [{ mint: "X", owner: "A", uiTokenAmount: {} }];
    const post = [{ mint: "X", owner: "A", uiTokenAmount: { uiAmount: 5 } }];
    const r = diffTokenBalances(pre, post, "A");
    expect(r.token_out).toBe("X");
  });
});

describe("parseTransactionEvent", () => {
  const samplePayload = {
    signature: "sig123",
    slot: 12345,
    transaction: {
      transaction: {
        signatures: ["sig123"],
        message: {
          accountKeys: ["walletA", "walletB"],
        },
      },
      meta: {
        preTokenBalances: [
          { mint: "SOL_MINT", owner: "walletA", uiTokenAmount: { uiAmount: 10 } },
        ],
        postTokenBalances: [
          { mint: "SOL_MINT", owner: "walletA", uiTokenAmount: { uiAmount: 8 } },
          { mint: "BONK_MINT", owner: "walletA", uiTokenAmount: { uiAmount: 5000 } },
        ],
      },
    },
  };

  it("emits a swap event when token balances changed", () => {
    const ev = parseTransactionEvent(samplePayload);
    expect(ev).not.toBeNull();
    expect(ev.kind).toBe("swap");
    expect(ev.signature).toBe("sig123");
    expect(ev.slot).toBe(12345);
    expect(ev.wallet).toBe("walletA");
    expect(ev.token_in).toBe("SOL_MINT");
    expect(ev.token_out).toBe("BONK_MINT");
  });

  it("returns null on empty payload", () => {
    expect(parseTransactionEvent({})).toBeNull();
    expect(parseTransactionEvent(null)).toBeNull();
  });

  it("emits kind=tx when no token movement detected", () => {
    const flat = {
      signature: "sig456",
      slot: 1,
      transaction: {
        transaction: {
          signatures: ["sig456"],
          message: { accountKeys: ["walletA"] },
        },
        meta: { preTokenBalances: [], postTokenBalances: [] },
      },
    };
    const ev = parseTransactionEvent(flat);
    expect(ev.kind).toBe("tx");
    expect(ev.token_in).toBeNull();
  });

  it("supports accountKeys as objects with pubkey", () => {
    const payload = {
      signature: "sig789",
      slot: 1,
      transaction: {
        transaction: {
          signatures: ["sig789"],
          message: { accountKeys: [{ pubkey: "walletObjectA" }] },
        },
        meta: { preTokenBalances: [], postTokenBalances: [] },
      },
    };
    const ev = parseTransactionEvent(payload);
    expect(ev.wallet).toBe("walletObjectA");
  });
});

describe("startGeyserStream", () => {
  it("fail-soft: returns null when env not set", () => {
    delete process.env.HELIUS_ATLAS_WS_URL;
    delete process.env.HELIUS_GEYSER_URL;
    expect(startGeyserStream()).toBeNull();
  });
});
