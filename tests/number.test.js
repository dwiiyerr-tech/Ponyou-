import { describe, it, expect } from "vitest";
import { safeNumber } from "../utils/number.js";

describe("safeNumber", () => {
  it("returns finite number for valid input", () => {
    expect(safeNumber(42)).toBe(42);
    expect(safeNumber("3.14")).toBeCloseTo(3.14);
    expect(safeNumber("0")).toBe(0);
    expect(safeNumber(-5)).toBe(-5);
  });

  it("returns fallback for non-finite values", () => {
    expect(safeNumber(NaN)).toBeNull();
    expect(safeNumber(Infinity)).toBeNull();
    expect(safeNumber(-Infinity)).toBeNull();
    expect(safeNumber("not-a-number")).toBeNull();
    expect(safeNumber(undefined)).toBeNull();
  });

  it("Number(null) === 0 — known JS quirk, safeNumber returns 0", () => {
    // Documents the surprising behavior so future readers don't accidentally
    // change it. Number(null) is 0 per spec, hence finite.
    expect(safeNumber(null)).toBe(0);
  });

  it("respects custom fallback", () => {
    expect(safeNumber("abc", -1)).toBe(-1);
    expect(safeNumber(NaN, 0)).toBe(0);
  });
});
