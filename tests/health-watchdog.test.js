/**
 * Health watchdog — liveness assertions against silent failure.
 * Every check is exercised through injected deps; no real fs/state/agents.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { risk: { maxPositions: 3 }, watchdog: { enabled: true, frozenHours: 6, reAlertHours: 6 } },
}));
vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../agents/agent-registry.js", () => ({ getAllAgentStatuses: vi.fn(() => []) }));
vi.mock("../state.js", () => ({ getState: vi.fn(() => ({ positions: {}, recentEvents: [] })) }));
vi.mock("../llm-provider.js", () => ({ getLastLlmSuccessTs: vi.fn(() => null) }));

const { collectLiveness, runWatchdogCycle, formatLivenessReport, _resetWatchdogState } =
  await import("../tools/health-watchdog.js");

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

// Healthy baseline deps — each test breaks exactly one thing.
function deps(over = {}) {
  return {
    now: NOW,
    uptimeMs: 12 * HOUR,
    agentStatuses: [
      { name: "management", status: "running", lastHeartbeat: new Date(NOW - 5 * MIN).toISOString() },
      { name: "learning",   status: "running", lastHeartbeat: new Date(NOW - 2 * HOUR).toISOString() },
      { name: "screening",  status: "stopped", lastHeartbeat: new Date(NOW - 9 * HOUR).toISOString() },
    ],
    state: {
      positions: { "m1::w": { closed: false }, "m2::w": { closed: true } },
      recentEvents: [
        { ts: new Date(NOW - 2 * HOUR).toISOString(), action: "deploy" },
        { ts: new Date(NOW - 1 * HOUR).toISOString(), action: "close" },
      ],
    },
    lastLlmSuccessTs: NOW - 30 * MIN,
    maxPositions: 3,
    frozenHours: 6,
    fileMtime: vi.fn(() => NOW - 4 * MIN),
    ...over,
  };
}

beforeEach(() => _resetWatchdogState());

describe("collectLiveness", () => {
  it("all green on a healthy system; stopped agents are not asserted", () => {
    const checks = collectLiveness(deps());
    expect(checks.every(c => c.ok)).toBe(true);
    expect(checks.find(c => c.id === "agent:screening")).toBeUndefined();
    expect(checks.find(c => c.id === "agent:management").ok).toBe(true);
  });

  it("flags a running agent whose heartbeat exceeds its cadence", () => {
    const d = deps();
    d.agentStatuses[0].lastHeartbeat = new Date(NOW - 2 * HOUR).toISOString(); // management limit 25m
    const checks = collectLiveness(d);
    const c = checks.find(x => x.id === "agent:management");
    expect(c.ok).toBe(false);
    expect(c.critical).toBe(true);
  });

  it("book_frozen: full book + no close for hours = exits dead", () => {
    const d = deps({
      state: {
        positions: { a: { closed: false }, b: { closed: false }, c: { closed: false } },
        recentEvents: [{ ts: new Date(NOW - 10 * HOUR).toISOString(), action: "close" }],
      },
    });
    const c = collectLiveness(d).find(x => x.id === "book_frozen");
    expect(c.ok).toBe(false);
    expect(c.critical).toBe(true);
  });

  it("book_frozen stays quiet on a fresh boot even with a full book", () => {
    const d = deps({
      uptimeMs: 30 * MIN,
      state: { positions: { a: { closed: false }, b: { closed: false }, c: { closed: false } }, recentEvents: [] },
    });
    expect(collectLiveness(d).find(x => x.id === "book_frozen").ok).toBe(true);
  });

  it("learning_writes: recent buy but stale learning file = listeners dead", () => {
    const d = deps({ fileMtime: vi.fn(() => NOW - 8 * HOUR) });
    expect(collectLiveness(d).find(x => x.id === "learning_writes").ok).toBe(false);
  });

  it("learning_writes passes when there were no buys in 24h", () => {
    const d = deps({ state: { positions: {}, recentEvents: [] }, fileMtime: vi.fn(() => null) });
    expect(collectLiveness(d).find(x => x.id === "learning_writes").ok).toBe(true);
  });

  it("llm_liveness: zero successes past the grace window = provider dead", () => {
    const c = collectLiveness(deps({ lastLlmSuccessTs: null })).find(x => x.id === "llm_liveness");
    expect(c.ok).toBe(false);
    expect(c.critical).toBe(true);
  });

  it("llm_liveness tolerates no calls during early uptime", () => {
    const c = collectLiveness(deps({ lastLlmSuccessTs: null, uptimeMs: 20 * MIN }))
      .find(x => x.id === "llm_liveness");
    expect(c.ok).toBe(true);
  });

  it("vault/shadow freshness: stale snapshot file fails", () => {
    const d = deps({ fileMtime: vi.fn((f) => f.includes("_darwin") ? NOW - 2 * HOUR : NOW - MIN) });
    const checks = collectLiveness(d);
    expect(checks.find(x => x.id === "vault_freshness").ok).toBe(false);
    expect(checks.find(x => x.id === "shadow_freshness").ok).toBe(true);
  });
});

describe("runWatchdogCycle alerting", () => {
  it("alerts once on alive→dead, stays quiet while throttled, sends recovery", async () => {
    const send = vi.fn();
    const dead = deps({ lastLlmSuccessTs: null });

    await runWatchdogCycle({ send, overrides: dead });
    const downAlerts = send.mock.calls.filter(c => c[0].includes("DOWN"));
    expect(downAlerts.length).toBe(1);
    expect(downAlerts[0][0]).toContain("llm_liveness");

    send.mockClear();
    await runWatchdogCycle({ send, overrides: { ...dead, now: NOW + 10 * MIN } });
    expect(send.mock.calls.filter(c => c[0].includes("DOWN")).length).toBe(0); // throttled

    send.mockClear();
    await runWatchdogCycle({ send, overrides: deps({ now: NOW + 20 * MIN }) });
    expect(send.mock.calls.some(c => c[0].includes("RECOVERED: llm_liveness"))).toBe(true);
  });

  it("re-alerts after the throttle window while still down", async () => {
    const send = vi.fn();
    const dead = deps({ lastLlmSuccessTs: null });
    await runWatchdogCycle({ send, overrides: dead });
    send.mockClear();
    await runWatchdogCycle({ send, overrides: { ...dead, now: NOW + 7 * HOUR } });
    expect(send.mock.calls.some(c => c[0].includes("STILL DOWN"))).toBe(true);
  });

  it("a failing send never breaks the cycle", async () => {
    const send = vi.fn(() => { throw new Error("telegram down"); });
    await expect(runWatchdogCycle({ send, overrides: deps({ lastLlmSuccessTs: null }) }))
      .resolves.toBeTruthy();
  });
});

describe("formatLivenessReport", () => {
  it("renders a per-check HTML table with alive count", () => {
    const html = formatLivenessReport(collectLiveness(deps({ lastLlmSuccessTs: null })));
    expect(html).toContain("Liveness");
    expect(html).toContain("llm_liveness");
    expect(html).toContain("🚨");
  });
});
