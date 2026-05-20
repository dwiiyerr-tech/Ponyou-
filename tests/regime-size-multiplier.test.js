import { describe, expect, it } from "vitest";
import { computeRegimeSizeMultiplier } from "../market-safety.js";

describe("computeRegimeSizeMultiplier", () => {
  it("cuts sizing to 25% when SOL drops more than 5%", () => {
    expect(computeRegimeSizeMultiplier(94.9, 100, "NORMAL")).toBe(0.25);
  });

  it("cuts sizing to 50% in cold markets", () => {
    expect(computeRegimeSizeMultiplier(100, 100, "COLD")).toBe(0.5);
  });

  it("skips sizing in dead markets", () => {
    expect(computeRegimeSizeMultiplier(100, 100, "DEAD")).toBe(0);
  });

  it("keeps full sizing in normal markets", () => {
    expect(computeRegimeSizeMultiplier(100, 100, "NORMAL")).toBe(1);
  });

  it("keeps full sizing when SOL drop is below 5%", () => {
    expect(computeRegimeSizeMultiplier(95.1, 100, "NORMAL")).toBe(1);
  });
});
