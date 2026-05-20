import { describe, expect, it } from "vitest";
import { SEVERITY, aggregateSeverity, shouldEmit } from "../rug-monitor.js";

describe("severity engine", () => {
  it("aggregates per-detector severity by max", () => {
    expect(aggregateSeverity({ a: SEVERITY.LOW, b: SEVERITY.HIGH })).toBe(SEVERITY.HIGH);
    expect(aggregateSeverity({ a: SEVERITY.NONE, b: SEVERITY.NONE })).toBe(SEVERITY.NONE);
    expect(aggregateSeverity({})).toBe(SEVERITY.NONE);
  });

  it("emits only on strict upgrade, never downgrade", () => {
    expect(shouldEmit(SEVERITY.MEDIUM, SEVERITY.LOW)).toBe(true);
    expect(shouldEmit(SEVERITY.HIGH, SEVERITY.MEDIUM)).toBe(true);
    expect(shouldEmit(SEVERITY.MEDIUM, SEVERITY.MEDIUM)).toBe(false);
    expect(shouldEmit(SEVERITY.LOW, SEVERITY.HIGH)).toBe(false);
    expect(shouldEmit(SEVERITY.NONE, SEVERITY.LOW)).toBe(false);
  });
});

import { detectDevSell } from "../rug-monitor.js";

describe("detectDevSell", () => {
  const thresholds = { low: -5, medium: -20, high: -50 };

  it("returns NONE when delta is positive or zero", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 1100, thresholds })).toBe(SEVERITY.NONE);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 1000, thresholds })).toBe(SEVERITY.NONE);
  });

  it("returns LOW for 5-20% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 940, thresholds })).toBe(SEVERITY.LOW);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 810, thresholds })).toBe(SEVERITY.LOW);
  });

  it("returns MEDIUM for 20-50% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 790, thresholds })).toBe(SEVERITY.MEDIUM);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 510, thresholds })).toBe(SEVERITY.MEDIUM);
  });

  it("returns HIGH for >=50% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 500, thresholds })).toBe(SEVERITY.HIGH);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 0, thresholds })).toBe(SEVERITY.HIGH);
  });

  it("returns NONE for invalid entry balance", () => {
    expect(detectDevSell({ balanceAtEntry: 0, currentBalance: 100, thresholds })).toBe(SEVERITY.NONE);
    expect(detectDevSell({ balanceAtEntry: null, currentBalance: 100, thresholds })).toBe(SEVERITY.NONE);
  });
});

import { detectLpMovement, BURN_ADDRESSES, LP_PROGRAMS } from "../rug-monitor.js";

describe("detectLpMovement", () => {
  const thresholds = { low: -20, medium: -50, high: null };
  const deployer = "Dep111111111111111111111111111111111111111";

  it("returns NONE when LP unchanged", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 100000, thresholds })).toBe(SEVERITY.NONE);
  });
  it("returns NONE for <20% drop, LOW at 20%+", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 85000, thresholds })).toBe(SEVERITY.NONE);
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 79000, thresholds })).toBe(SEVERITY.LOW);
  });
  it("returns MEDIUM for 20-50% drop", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 60000, thresholds })).toBe(SEVERITY.MEDIUM);
  });
  it("returns HIGH for >50% drop", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 40000, thresholds: { low: -20, medium: -50, high: -50 } })).toBe(SEVERITY.HIGH);
  });
  it("returns NONE when LP transfer goes to known burn", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 0, transferTo: "1nc1nerator11111111111111111111111111111111", thresholds })).toBe(SEVERITY.NONE);
  });
  it("returns HIGH on removeLiquidity by deployer regardless of drop", () => {
    expect(detectLpMovement({ lpAtEntry: 100000, currentLp: 95000, removeLiquidityBy: deployer, deployerWallet: deployer, thresholds })).toBe(SEVERITY.HIGH);
  });
  it("exposes burn addresses + LP programs", () => {
    expect(BURN_ADDRESSES).toContain("1nc1nerator11111111111111111111111111111111");
    expect(LP_PROGRAMS.raydiumV4).toBe("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  });
});

import { detectAuthorityChange } from "../rug-monitor.js";

describe("detectAuthorityChange", () => {
  it("returns NONE when both authorities unchanged", () => {
    expect(detectAuthorityChange({ atEntry: { mint_authority: null, freeze_authority: null }, current: { mint_authority: null, freeze_authority: null } })).toBe(SEVERITY.NONE);
  });
  it("returns HIGH when mint authority null -> address", () => {
    expect(detectAuthorityChange({ atEntry: { mint_authority: null, freeze_authority: null }, current: { mint_authority: "Auth111111111111111111111111111111111111111", freeze_authority: null } })).toBe(SEVERITY.HIGH);
  });
  it("returns HIGH when freeze authority null -> address", () => {
    expect(detectAuthorityChange({ atEntry: { mint_authority: null, freeze_authority: null }, current: { mint_authority: null, freeze_authority: "Auth222222222222222222222222222222222222222" } })).toBe(SEVERITY.HIGH);
  });
  it("returns LOW when authority transferred to burn", () => {
    expect(detectAuthorityChange({ atEntry: { mint_authority: "Auth1111111111111111111111111111111111111111", freeze_authority: null }, current: { mint_authority: "1nc1nerator11111111111111111111111111111111", freeze_authority: null } })).toBe(SEVERITY.LOW);
  });
});
