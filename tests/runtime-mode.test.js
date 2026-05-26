import { describe, expect, it } from "vitest";
import { resolveExecutionMode } from "../runtime-mode.js";

describe("resolveExecutionMode", () => {
  it("uses demo when executionMode is explicitly set", () => {
    const result = resolveExecutionMode({
      env: {},
      userConfig: { executionMode: "demo" },
    });
    expect(result.isDemo).toBe(true);
    expect(result.label).toBe("DEMO (paper trade)");
  });

  it("keeps backward compatibility with dryRun config", () => {
    const result = resolveExecutionMode({
      env: {},
      userConfig: { dryRun: true },
    });
    expect(result.isDemo).toBe(true);
    expect(result.legacyDryRun).toBe(true);
  });

  it("treats DEMO_MODE env as the same unified mode", () => {
    const result = resolveExecutionMode({
      env: { DEMO_MODE: "true" },
      userConfig: {},
    });
    expect(result.mode).toBe("demo");
  });

  it("defaults to live when no flag is enabled", () => {
    const result = resolveExecutionMode({
      env: {},
      userConfig: {},
    });
    expect(result.isLive).toBe(true);
    expect(result.label).toBe("LIVE (mainnet)");
  });
});
