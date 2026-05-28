// Regression tests for J11 price-impact format normalization + slippage clamp.
// These are pure helpers — no Jupiter network calls.

import { describe, it, expect } from "vitest";
import { normalizePriceImpactToPercent } from "../tools/jupiter.js";

describe("normalizePriceImpactToPercent", () => {
  it("returns null for null/undefined", () => {
    expect(normalizePriceImpactToPercent(null)).toBeNull();
    expect(normalizePriceImpactToPercent(undefined)).toBeNull();
  });

  it("returns null for non-numeric", () => {
    expect(normalizePriceImpactToPercent("abc")).toBeNull();
    expect(normalizePriceImpactToPercent(NaN)).toBeNull();
  });

  // Jupiter V6 canonical format: decimal fraction.
  it("converts decimal fraction to percent: 0.0042 → 0.42%", () => {
    expect(normalizePriceImpactToPercent("0.0042")).toBeCloseTo(0.42, 4);
  });

  it("converts decimal fraction to percent: 0.05 → 5%", () => {
    expect(normalizePriceImpactToPercent("0.05")).toBeCloseTo(5, 4);
  });

  it("converts decimal fraction at boundary 0.99 → 99%", () => {
    expect(normalizePriceImpactToPercent(0.99)).toBeCloseTo(99, 4);
  });

  // Legacy / alt provider that already gives percent.
  it("passes through percent format >=1: 5 → 5%", () => {
    expect(normalizePriceImpactToPercent(5)).toBeCloseTo(5, 4);
  });

  it("passes through percent format at exactly 1: 1 → 1%", () => {
    expect(normalizePriceImpactToPercent(1)).toBeCloseTo(1, 4);
  });

  it("passes through percent format 15 → 15%", () => {
    expect(normalizePriceImpactToPercent("15")).toBeCloseTo(15, 4);
  });

  it("zero stays zero", () => {
    expect(normalizePriceImpactToPercent(0)).toBe(0);
  });
});
