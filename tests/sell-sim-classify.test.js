/**
 * Sell-sim error classification: InvalidAccountForFee means the borrowed
 * holder owner (often a pool/bonding-curve PDA) can't pay the simulated fee.
 * That says nothing about sellability — it must classify as inconclusive
 * (can_sell=null) with an explicit reason, not fall through to unknown_sim.
 */
import { describe, it, expect } from "vitest";
import { classifySellSimError } from "../tools/sell-simulator.js";

describe("classifySellSimError", () => {
  it("maps InvalidAccountForFee to an explicit inconclusive reason", () => {
    const r = classifySellSimError("InvalidAccountForFee");
    expect(r.can_sell).toBe(null);
    expect(r.reason).toMatch(/fee_payer_rejected/);
  });

  it("maps object-shaped InvalidAccountForFee errors too", () => {
    const r = classifySellSimError({ TransactionError: "InvalidAccountForFee" });
    expect(r.can_sell).toBe(null);
    expect(r.reason).toMatch(/fee_payer_rejected/);
  });

  it("still passes clean simulations", () => {
    expect(classifySellSimError(null).can_sell).toBe(true);
  });

  it("still treats signature errors as expected sim noise", () => {
    const r = classifySellSimError("SignatureVerificationFailed");
    expect(r.can_sell).toBe(true);
  });

  it("still flags custom program errors as honeypot", () => {
    const r = classifySellSimError("Custom:0x1771");
    expect(r.can_sell).toBe(false);
  });

  it("keeps unknown errors inconclusive", () => {
    const r = classifySellSimError("SomethingNovel");
    expect(r.can_sell).toBe(null);
    expect(r.reason).toMatch(/unknown_sim/);
  });
});
