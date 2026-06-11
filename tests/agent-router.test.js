import { describe, expect, it } from "vitest";
import AgentRouter from "../agent-router.js";

describe("agent router with Gemini disabled", () => {
  it("routes all research tasks directly to claude", () => {
    const router = new AgentRouter({ callLLM: async () => "ok" });
    // "market trend" used to route to Gemini. Now Gemini disabled → Claude direct.
    const selection = router.selectAgent("market trend", { minConfidence: 0.7 });

    expect(selection.classified.agent).toBe("claude");
    expect(selection.agent).toBe("claude");
  });

  it("routes trading decisions to claude", () => {
    const router = new AgentRouter({ callLLM: async () => "ok" });
    const selection = router.selectAgent("should i buy this token signal entry");

    expect(selection.agent).toBe("claude");
  });

  it("keeps safety-sensitive prompts on claude", () => {
    const router = new AgentRouter({ callLLM: async () => "ok" });
    // "market trend" now routes directly to Claude (Gemini disabled).
    // Safety-sensitive flag ensures it stays on Claude.
    const selection = router.selectAgent("market trend", { safetySensitive: true });

    expect(selection.agent).toBe("claude");
    // Reason is "trading" because Claude is the default now for all keywords
  });
});

describe("circuit breaker fallback (main LLM down)", () => {
  // Drive the private breaker through the public invoke() path: 3 invokes
  // whose callLLM always rejects trip the breaker for "claude".
  async function tripClaude(router) {
    for (let i = 0; i < 3; i++) {
      await router.invoke("should i buy this token signal entry", { preferAgent: "claude", timeoutMs: 1000 });
    }
  }

  it("reroutes to gemini when the claude breaker is open (was a self no-op)", async () => {
    const router = new AgentRouter({ callLLM: async () => { throw new Error("Connection error."); }, geminiBin: "/nonexistent-gemini" });
    await tripClaude(router);
    const selection = router.selectAgent("should i buy this token signal entry");
    expect(selection.reason).toBe("breaker_tripped:claude");
    expect(selection.agent).toBe("gemini");
  }, 30000);

  it("falls back to gemini in invoke() when the main LLM fails", async () => {
    // gemini is exec'd as `bin -p <prompt>`; pointing the bin at node makes
    // `node -p '<prompt>'` evaluate the prompt and print a known answer.
    const router = new AgentRouter({
      callLLM: async () => { throw new Error("Connection error."); },
      geminiBin: process.execPath,
    });
    const r = await router.invoke("'fallback-ok'", { preferAgent: "claude", timeoutMs: 5000 });
    expect(r.error).toBeNull();
    expect(r.result).toBe("fallback-ok");
  }, 30000);

  it("fallback success still counts as a primary failure (breaker can trip)", async () => {
    const router = new AgentRouter({
      callLLM: async () => { throw new Error("Connection error."); },
      geminiBin: process.execPath,
    });
    for (let i = 0; i < 3; i++) {
      const r = await router.invoke("'ok'", { preferAgent: "claude", timeoutMs: 5000 });
      expect(r.error).toBeNull();
    }
    // After 3 served-by-fallback calls the claude breaker must be open.
    const selection = router.selectAgent("should i buy this token signal entry");
    expect(selection.reason).toBe("breaker_tripped:claude");
    expect(selection.agent).toBe("gemini");
  }, 30000);
});
