/**
 * Tests for the pro-orchestrator unlock paths:
 *   - validation mode defaults ON in demo (shadow-only), hard-off in live
 *   - approveAutomation honors the proForceApprove operator override
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENV_KEYS = ["EXECUTION_MODE", "DRY_RUN", "PRO_VALIDATION_MODE"];
const SAVED = {};

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  vi.resetModules();
});

function mockFs() {
  vi.doMock("fs", async (importOriginal) => {
    const actual = await importOriginal();
    const patched = { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "{}") };
    return { ...patched, default: patched };
  });
}

function mockProDeps(proConfig = {}) {
  vi.doMock("../agents/agent-bus.js",     () => ({ agentBus: { subscribe: vi.fn(() => vi.fn()), emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
  vi.doMock("../agents/agent-registry.js",() => ({ setAgentStatus: vi.fn(), updateAgentHealth: vi.fn() }));
  vi.doMock("../logger.js",               () => ({ log: vi.fn() }));
  vi.doMock("../tools/cast-net-gate.js",  () => ({ evaluateCastNet: vi.fn(() => ({ allowed: false })) }));
  vi.doMock("../strategies.js",           () => ({ getActiveStrategy: vi.fn(() => ({ id: "scalping" })) }));
  vi.doMock("../tools/trash-filter.js",   () => ({ scoreTrash: vi.fn(() => ({ score: 20 })) }));
  vi.doMock("../conviction-memory.js",    () => ({ getExperienceScore: vi.fn(() => 0) }));
  vi.doMock("../tools/wallet-manager.js", () => ({ getAllWallets: vi.fn(() => []) }));
  vi.doMock("../atomic-write.js",         () => ({ atomicWriteJson: vi.fn() }));
  vi.doMock("../config.js",               () => ({ config: { pro: proConfig } }));
  mockFs();
}

describe("pro validation mode: default-on in demo, never in live", () => {
  it("activates by default in demo with no config at all", async () => {
    mockProDeps({});
    process.env.EXECUTION_MODE = "demo";
    const mod = await import("../agents/pro-orchestrator.js");
    mod.initProOrchestrator();
    expect(mod.isProValidationMode()).toBe(true);
  });

  it("stays OFF in live even when explicitly requested (hard gate)", async () => {
    mockProDeps({ validationMode: true });
    process.env.EXECUTION_MODE = "live";
    const mod = await import("../agents/pro-orchestrator.js");
    mod.initProOrchestrator();
    expect(mod.isProValidationMode()).toBe(false);
  });

  it("respects the explicit opt-out in demo (proValidationMode: false)", async () => {
    mockProDeps({ validationMode: false });
    process.env.EXECUTION_MODE = "demo";
    const mod = await import("../agents/pro-orchestrator.js");
    mod.initProOrchestrator();
    expect(mod.isProValidationMode()).toBe(false);
  });
});

function mockAutomationDeps(proConfig = {}) {
  vi.doMock("../agents/agent-bus.js",     () => ({ agentBus: { subscribe: vi.fn(() => vi.fn()), emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
  vi.doMock("../agents/agent-registry.js",() => ({ setAgentStatus: vi.fn(), updateAgentHealth: vi.fn() }));
  vi.doMock("../logger.js",               () => ({ log: vi.fn() }));
  vi.doMock("../atomic-write.js",         () => ({ atomicWriteJson: vi.fn() }));
  vi.doMock("../config.js",               () => ({ config: { pro: proConfig } }));
  mockFs();
}

describe("approveAutomation: proForceApprove override", () => {
  // With fs fully mocked empty, all 8 qualification checks fail.

  it("blocks activation when unqualified and no override", async () => {
    mockAutomationDeps({});
    const { approveAutomation, isAutomationActive } = await import("../agents/automation-rules.js");
    const res = approveAutomation();
    expect(res.ok).toBe(false);
    expect(res.failedChecks?.length).toBeGreaterThan(0);
    expect(isAutomationActive()).toBe(false);
  });

  it("activates when unqualified but proForceApprove: true, flagged as forced", async () => {
    mockAutomationDeps({ forceApprove: true });
    const { approveAutomation, isAutomationActive, getAutomationState } = await import("../agents/automation-rules.js");
    const res = approveAutomation();
    expect(res.ok).toBe(true);
    expect(res.forced).toBe(true);
    expect(isAutomationActive()).toBe(true);
    // The forced activation must not fake a passed gate.
    expect(getAutomationState().qualified).toBe(false);
    expect(getAutomationState().forcedApproval).toBe(true);
  });
});
