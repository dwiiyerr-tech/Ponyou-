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
