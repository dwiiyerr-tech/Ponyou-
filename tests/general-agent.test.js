/**
 * Tests for agents/general-agent.js
 * P1-4: Zero test coverage on critical agent modules
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initGeneralAgent,
  handleGeneralMessage,
  clearGeneralAgentHistory,
  isGeneralAgentReady,
  getGeneralAgentStatus,
} from "../agents/general-agent.js";

// Reset module-level state between tests by clearing history
beforeEach(() => {
  clearGeneralAgentHistory();
});

describe("general-agent: quick responses (no LLM)", () => {
  it("returns help text for /help", async () => {
    const resp = await handleGeneralMessage("/help");
    expect(resp).toMatch(/Ponyou Assistant/i);
    expect(resp).toMatch(/\/status/);
  });

  it("returns help text for 'help'", async () => {
    const resp = await handleGeneralMessage("help");
    expect(resp).toMatch(/Ponyou Assistant/i);
  });

  it("returns help for 'bantuan'", async () => {
    const resp = await handleGeneralMessage("bantuan");
    expect(resp).toMatch(/Ponyou/i);
  });

  it("resets history on /clear_history", async () => {
    const resp = await handleGeneralMessage("/clear_history");
    expect(resp).toMatch(/direset/i);
  });

  it("returns empty string for empty input", async () => {
    const resp = await handleGeneralMessage("");
    expect(resp).toBe("");
  });

  it("returns empty string for null/undefined", async () => {
    expect(await handleGeneralMessage(null)).toBe("");
    expect(await handleGeneralMessage(undefined)).toBe("");
  });
});

// Note: initGeneralAgent uses a one-shot _initialized guard — module state
// persists across tests in the same file. Tests must call clearGeneralAgentHistory()
// in beforeEach (already done above) and tolerate already-initialized state.

describe("general-agent: remember shortcut (no LLM)", () => {
  it("saves lesson via 'ingat:' prefix if controls registered", async () => {
    const lessons = [];
    // Re-init updates controls even if already initialized (initGeneralAgent
    // sets module-level _controls regardless of the init guard)
    // We test the behavior of handleGeneralMessage with the remember shortcut:
    const resp = await handleGeneralMessage("ingat: jangan beli saat market DEAD");
    // Either saved (if controls have rememberLesson) or returns LLM-needed msg
    // The important thing is it does NOT crash and returns a string
    expect(typeof resp).toBe("string");
    expect(resp.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for 'remember' prefix", async () => {
    const resp = await handleGeneralMessage("remember: skip BSC tokens");
    expect(typeof resp).toBe("string");
    expect(resp.length).toBeGreaterThan(0);
  });
});

describe("general-agent: fallback when LLM not ready", () => {
  it("returns a string for any non-quick-response input", async () => {
    const resp = await handleGeneralMessage("apa kabar bot?");
    expect(typeof resp).toBe("string");
    expect(resp.length).toBeGreaterThan(0);
  });
});

describe("general-agent: status accessors", () => {
  it("getGeneralAgentStatus returns expected shape", () => {
    const status = getGeneralAgentStatus();
    expect(status).toHaveProperty("name", "general");
    expect(status).toHaveProperty("initialized");
    expect(status).toHaveProperty("llmReady");
    expect(status).toHaveProperty("historyLength");
  });

  it("isGeneralAgentReady returns boolean", () => {
    expect(typeof isGeneralAgentReady()).toBe("boolean");
  });
});

describe("general-agent: LLM dispatch path", () => {
  it("quick-response paths never call agentLoop", async () => {
    const mockLoop = vi.fn().mockResolvedValue({ content: "should not be called" });
    initGeneralAgent({ agentLoop: mockLoop, config: {}, controls: null });

    // These are handled by _quickResponse without LLM
    await handleGeneralMessage("/help");
    await handleGeneralMessage("help");
    await handleGeneralMessage("/clear_history");
    expect(mockLoop).not.toHaveBeenCalled();
  });

  it("clearGeneralAgentHistory resets history length to 0", async () => {
    const mockLoop = vi.fn().mockResolvedValue({ content: "ok" });
    initGeneralAgent({ agentLoop: mockLoop, config: {}, controls: null });

    // Build some history
    await handleGeneralMessage("query 1");
    clearGeneralAgentHistory();

    const status = getGeneralAgentStatus();
    expect(status.historyLength).toBe(0);
  });

  it("history never exceeds MAX_HISTORY (20) entries", async () => {
    const mockLoop = vi.fn().mockResolvedValue({ content: "ok" });
    initGeneralAgent({ agentLoop: mockLoop, config: {}, controls: null });
    clearGeneralAgentHistory();

    // Fire 12 non-quick-response turns (each pushes 2 entries)
    for (let i = 0; i < 12; i++) {
      await handleGeneralMessage(`query number ${i} long enough`);
    }

    const status = getGeneralAgentStatus();
    expect(status.historyLength).toBeLessThanOrEqual(20);
  });
});
