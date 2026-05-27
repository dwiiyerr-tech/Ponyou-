// Tests for MGMT-3 hard guard in tools/executor.js — pure helper.
import { describe, it, expect } from "vitest";
import { checkManagedGuard, MIN_MANAGED_HOLD_MIN } from "../tools/executor.js";

const MINT = "9xH72gnPGEf4HpDoiTrPDexJ7M5cQpUmwTm12P3Vpump";
const SOL  = "So11111111111111111111111111111111111111112";
const NOW  = 1_750_000_000_000;

function minutesAgo(min) { return new Date(NOW - min * 60_000).toISOString(); }

describe("checkManagedGuard", () => {
  it("passes a BUY (token_in is SOL)", () => {
    const r = checkManagedGuard({ token_in: "SOL", token_out: MINT }, () => null, { now: NOW });
    expect(r.pass).toBe(true);
  });

  it("passes a SELL when no tracked position exists", () => {
    const r = checkManagedGuard({ token_in: MINT, token_out: SOL }, () => null, { now: NOW });
    expect(r.pass).toBe(true);
  });

  it("blocks a SELL on a position younger than MIN_MANAGED_HOLD_MIN", () => {
    const tracked = { deployed_at: minutesAgo(2) };
    const r = checkManagedGuard({ token_in: MINT, token_out: SOL }, () => tracked, { now: NOW });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/only 2\.0min old/);
    expect(r.reason).toMatch(new RegExp(`min ${MIN_MANAGED_HOLD_MIN}min`));
  });

  it("allows a SELL once the position is past MIN_MANAGED_HOLD_MIN", () => {
    const tracked = { deployed_at: minutesAgo(10) };
    const r = checkManagedGuard({ token_in: MINT, token_out: SOL }, () => tracked, { now: NOW });
    expect(r.pass).toBe(true);
  });

  it("blocks a SELL on a position past partial-TP (trailing owns it)", () => {
    const tracked = {
      deployed_at: minutesAgo(60),
      partial_tp_done: true,
      partial_tp_done_at: "2025-01-01T00:00:00Z",
    };
    const r = checkManagedGuard({ token_in: MINT, token_out: SOL }, () => tracked, { now: NOW });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/past partial TP/);
  });

  it("allows a SELL when rug_force_exit is set (emergency override)", () => {
    const tracked = {
      deployed_at: minutesAgo(2),         // too young
      partial_tp_done: true,                // past partial-TP
      rug_force_exit: true,                 // emergency
    };
    const r = checkManagedGuard({ token_in: MINT, token_out: SOL }, () => tracked, { now: NOW });
    expect(r.pass).toBe(true);
  });

  it("allows a SELL when caller passes bypass_managed_guard:true", () => {
    const tracked = { deployed_at: minutesAgo(2), partial_tp_done: true };
    const r = checkManagedGuard(
      { token_in: MINT, token_out: SOL, bypass_managed_guard: true },
      () => tracked,
      { now: NOW },
    );
    expect(r.pass).toBe(true);
  });

  it("does not gate token-to-token swaps (neither side is SOL)", () => {
    const otherMint = "AnotherMintHere11111111111111111111111111111";
    const r = checkManagedGuard(
      { token_in: MINT, token_out: otherMint },
      () => ({ deployed_at: minutesAgo(1) }),
      { now: NOW },
    );
    expect(r.pass).toBe(true);
  });

  it("respects custom opts.minHoldMin", () => {
    const tracked = { deployed_at: minutesAgo(7) };
    const r = checkManagedGuard(
      { token_in: MINT, token_out: SOL },
      () => tracked,
      { now: NOW, minHoldMin: 10 },
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/min 10min/);
  });

  it("treats undefined deployed_at as Infinity (does not block on age)", () => {
    const tracked = { /* no deployed_at */ };
    const r = checkManagedGuard({ token_in: MINT, token_out: SOL }, () => tracked, { now: NOW });
    expect(r.pass).toBe(true);
  });
});
