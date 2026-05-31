import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveExecutionMode, demoStrictGates, applyPaperDataRedirect, PAPER_REDIRECT_STORES } from "../runtime-mode.js";
import os from "os";
import path from "path";

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

describe("demoStrictGates", () => {
  let saved;
  beforeEach(() => { saved = process.env.DEMO_STRICT_GATES; });
  afterEach(() => {
    if (saved === undefined) delete process.env.DEMO_STRICT_GATES;
    else process.env.DEMO_STRICT_GATES = saved;
  });

  it("is OFF by default (unset)", () => {
    delete process.env.DEMO_STRICT_GATES;
    expect(demoStrictGates()).toBe(false);
  });

  it("is ON for truthy flag values", () => {
    for (const v of ["true", "1", "on", "yes"]) {
      process.env.DEMO_STRICT_GATES = v;
      expect(demoStrictGates()).toBe(true);
    }
  });

  it("is OFF for falsy/garbage values", () => {
    for (const v of ["false", "0", "off", "no", "", "maybe"]) {
      process.env.DEMO_STRICT_GATES = v;
      expect(demoStrictGates()).toBe(false);
    }
  });
});

describe("applyPaperDataRedirect (demo learning isolation)", () => {
  const base = path.join(os.tmpdir(), "ponyou-redirect-test");

  it("does nothing in live mode", () => {
    const env = {};
    expect(applyPaperDataRedirect({ isDemo: false, env, baseDir: base })).toBeNull();
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("redirects every learning store into demo/ in demo mode", () => {
    const env = {};
    const dir = applyPaperDataRedirect({ isDemo: true, env, baseDir: base });
    expect(dir).toBe(path.join(base, "demo"));
    for (const [k, fname] of Object.entries(PAPER_REDIRECT_STORES)) {
      expect(env[k]).toBe(path.join(base, "demo", fname));
    }
  });

  it("does NOT redirect when PAPER_TRADING is explicitly false (real-wallet demo)", () => {
    const env = { PAPER_TRADING: "false" };
    expect(applyPaperDataRedirect({ isDemo: true, env, baseDir: base })).toBeNull();
    expect(env.PONYOU_STATE_FILE).toBeUndefined();
  });

  it("preserves an already-set override (test isolation wins)", () => {
    const env = { PONYOU_STATE_FILE: "/custom/state.json" };
    applyPaperDataRedirect({ isDemo: true, env, baseDir: base });
    expect(env.PONYOU_STATE_FILE).toBe("/custom/state.json");
    // but other stores still get redirected
    expect(env.PONYOU_LESSONS_FILE).toBe(path.join(base, "demo", "lessons.json"));
  });

  it("isolates the position store (state.json) so paper trades can't leak to live", () => {
    expect(PAPER_REDIRECT_STORES.PONYOU_STATE_FILE).toBe("state.json");
  });
});
