import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveExecutionMode, applyPaperDataRedirect, PAPER_REDIRECT_STORES } from "../runtime-mode.js";
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

describe("applyPaperDataRedirect (demo safety/session isolation)", () => {
  const base = path.join(os.tmpdir(), "ponyou-redirect-test");

  it("does nothing in live mode", () => {
    const env = {};
    expect(applyPaperDataRedirect({ isDemo: false, env, baseDir: base })).toBeNull();
    expect(Object.keys(env)).toHaveLength(0);
  });

  it("redirects safety/session stores into demo/ in demo mode", () => {
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
    // other safety stores still get redirected
    expect(env.PONYOU_KILL_SWITCH_STATE).toBe(path.join(base, "demo", "kill-switch-state.json"));
  });

  it("isolates the position store (state.json) so paper trades can't leak to live", () => {
    expect(PAPER_REDIRECT_STORES.PONYOU_STATE_FILE).toBe("state.json");
  });

  it("isolates simulated execution telemetry so it can't poison live routing/sizing", () => {
    // In DRY_RUN every swap "succeeds" with fake slippage/latency. These two
    // stores drive live wallet routing + position sizing, so they must stay in
    // demo/ (mirrors scripts/promote-demo.js refusing to promote them).
    expect(PAPER_REDIRECT_STORES.PONYOU_EXEC_QUALITY_FILE).toBe("execution-quality.json");
    expect(PAPER_REDIRECT_STORES.PONYOU_TRADE_ATTRIBUTION_FILE).toBe("trade-attribution.json");
  });

  it("keeps knowledge stores SHARED so demo data carries to live (not isolated)", () => {
    // These accumulate during demo and must be available to live — they must
    // NOT appear in the redirect map.
    for (const k of ["PONYOU_LESSONS_FILE", "PONYOU_CONVICTION_FILE", "PONYOU_RUG_MEMORY_FILE",
                     "PONYOU_REGIME_FILE", "PONYOU_DARWIN_FILE", "PONYOU_PERF_FILE"]) {
      expect(PAPER_REDIRECT_STORES[k]).toBeUndefined();
    }
  });
});
