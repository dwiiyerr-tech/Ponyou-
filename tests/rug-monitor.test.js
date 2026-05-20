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
