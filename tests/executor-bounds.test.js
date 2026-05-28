// Regression tests for EX-6: clampConfigValue must protect against
// LLM-driven config corruption. Without bounds, the LLM could disable
// trading entirely by setting managementIntervalMin=0 (invalid cron
// pattern → cron job fails to start).

import { describe, it, expect } from "vitest";
import { CONFIG_BOUNDS, clampConfigValue } from "../tools/executor.js";

describe("clampConfigValue — EX-6 bounds", () => {
  it("passes through unbounded keys unchanged", () => {
    const r = clampConfigValue("notAKey", 42);
    expect(r.clamped).toBe(false);
    expect(r.value).toBe(42);
  });

  it("clamps zero managementIntervalMin to min=1 (prevents invalid cron pattern)", () => {
    const r = clampConfigValue("managementIntervalMin", 0);
    expect(r.clamped).toBe(true);
    expect(r.value).toBe(1);
  });

  it("clamps absurd managementIntervalMin to max=60", () => {
    const r = clampConfigValue("managementIntervalMin", 99999);
    expect(r.clamped).toBe(true);
    expect(r.value).toBe(60);
  });

  it("clamps zero gasReserve to min (prevents LLM zeroing the safety margin)", () => {
    const r = clampConfigValue("gasReserve", 0);
    expect(r.clamped).toBe(true);
    expect(r.value).toBe(0.001);
  });

  it("clamps positive stopLossPct down to max=0 (SL must be non-positive)", () => {
    const r = clampConfigValue("stopLossPct", 10);
    expect(r.clamped).toBe(true);
    expect(r.value).toBe(0);
  });

  it("clamps stopLossPct below -90 up to min=-90", () => {
    const r = clampConfigValue("stopLossPct", -99);
    expect(r.clamped).toBe(true);
    expect(r.value).toBe(-90);
  });

  it("accepts value inside bounds without clamping", () => {
    const r = clampConfigValue("managementIntervalMin", 5);
    expect(r.clamped).toBe(false);
    expect(r.value).toBe(5);
  });

  it("ignores non-numeric input", () => {
    const r = clampConfigValue("managementIntervalMin", "abc");
    expect(r.clamped).toBe(false);
    expect(r.value).toBe("abc");
  });

  it("CONFIG_BOUNDS includes the operational-safety critical keys", () => {
    const required = [
      "managementIntervalMin",
      "screeningIntervalMin",
      "maxPositions",
      "gasReserve",
      "stopLossPct",
    ];
    for (const k of required) {
      expect(CONFIG_BOUNDS[k], `missing bounds for ${k}`).toBeDefined();
    }
  });
});
