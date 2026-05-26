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
