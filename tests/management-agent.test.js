// Tests for agents/management-agent.js — listener cleanup on re-init,
// unsubscriber error resilience, and basic cycle gate behavior.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubscribe = vi.fn(() => vi.fn()); // returns unsubscribe fn
const mockEmit      = vi.fn();

vi.mock("../agents/agent-bus.js",     () => ({
  agentBus: { subscribe: mockSubscribe, emit: mockEmit, on: vi.fn(), off: vi.fn() },
}));
vi.mock("../agents/agent-registry.js",() => ({ setAgentStatus: vi.fn(), updateAgentHealth: vi.fn() }));
vi.mock("../logger.js",               () => ({ log: vi.fn() }));

const { initManagementAgent, runManagementCycle, isLLMReviewEnabled } = await import("../agents/management-agent.js");

const mockCycle = vi.fn(async () => "done");
const mockGate  = vi.fn(async () => ({ blocked: false }));

describe("management-agent: listener cleanup on re-init (T3-12 / R1)", () => {
  beforeEach(() => { mockSubscribe.mockClear(); });

  it("registers expected bus subscriptions on first init", () => {
    initManagementAgent({ runManagementCycle: mockCycle, checkAllGates: mockGate });
    // Count matches the number of _unsubscribers.push() calls in management-agent.js
    expect(mockSubscribe.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("re-init cleans up previous listeners before registering new ones", () => {
    const unsub1 = vi.fn();
    mockSubscribe.mockReturnValueOnce(unsub1);
    initManagementAgent({ runManagementCycle: mockCycle, checkAllGates: mockGate });

    mockSubscribe.mockClear();
    initManagementAgent({ runManagementCycle: mockCycle, checkAllGates: mockGate });

    // unsub1 should have been called during cleanup
    expect(unsub1).toHaveBeenCalled();
  });

  it("re-init does not throw when unsubscriber throws (R1)", () => {
    const throwingUnsub = vi.fn(() => { throw new Error("already removed"); });
    mockSubscribe.mockReturnValueOnce(throwingUnsub);
    initManagementAgent({ runManagementCycle: mockCycle, checkAllGates: mockGate });

    // Second init should not throw even though throwingUnsub throws
    expect(() => {
      initManagementAgent({ runManagementCycle: mockCycle, checkAllGates: mockGate });
    }).not.toThrow();
  });

  it("registers new listeners even after unsubscriber error", () => {
    const throwingUnsub = vi.fn(() => { throw new Error("already removed"); });
    mockSubscribe.mockReturnValueOnce(throwingUnsub);
    initManagementAgent({ runManagementCycle: mockCycle, checkAllGates: mockGate });

    mockSubscribe.mockClear();
    initManagementAgent({ runManagementCycle: mockCycle, checkAllGates: mockGate });

    // New subscriptions must be registered despite the throwing unsubscriber
    expect(mockSubscribe.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("management-agent: runManagementCycle gate", () => {
  it("returns error message when not initialized", async () => {
    // Reset by importing a fresh module won't work (module is singleton),
    // but we can test the gate path when _runManagementCycle is set.
    const gate = vi.fn(async () => ({ blocked: true, reason: "kill switch active" }));
    initManagementAgent({ runManagementCycle: mockCycle, checkAllGates: gate });

    const result = await runManagementCycle({ silent: true });
    expect(result).toMatch(/kill switch/i);
    expect(mockCycle).not.toHaveBeenCalled();
  });

  it("calls runManagementCycle when gate passes", async () => {
    const gate = vi.fn(async () => ({ blocked: false }));
    const cycle = vi.fn(async () => "cycle ok");
    initManagementAgent({ runManagementCycle: cycle, checkAllGates: gate });

    mockCycle.mockClear();
    const result = await runManagementCycle({ silent: true });
    expect(cycle).toHaveBeenCalled();
    expect(result).toBe("cycle ok");
  });
});
