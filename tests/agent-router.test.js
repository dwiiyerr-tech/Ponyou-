import { describe, expect, it } from "vitest";
import AgentRouter from "../agent-router.js";

describe("agent router confidence gate", () => {
  it("escalates low-confidence cheap routes to claude", () => {
    const router = new AgentRouter({ callLLM: async () => "ok" });
    const selection = router.selectAgent("market trend debug", { minConfidence: 0.7 });

    expect(selection.classified.agent).toBe("gemini");
    expect(selection.classified.confidence).toBeLessThan(0.7);
    expect(selection.agent).toBe("claude");
    expect(selection.reason).toBe("low_confidence_escalation");
  });

  it("escalates safety-sensitive prompts even when confidence is high", () => {
    const router = new AgentRouter({ callLLM: async () => "ok" });
    const selection = router.selectAgent("market trend", { minConfidence: 0.7, safetySensitive: true });

    expect(selection.classified.agent).toBe("gemini");
    expect(selection.agent).toBe("claude");
    expect(selection.reason).toBe("safety_sensitive");
  });
});
