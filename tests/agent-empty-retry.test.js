/**
 * Empty-response resilience: nemotron sometimes returns neither content nor
 * tool_calls when a tools array is attached — deterministically, so three
 * identical retries all came back empty and chat replied "No response from
 * model.". The loop must (a) salvage reasoning_content when content is empty
 * and (b) drop tools on retry for non-tool-required goals.
 */
import { describe, it, expect, vi } from "vitest";

// Mock chain mirrors tests/agent.test.js, but with a scripted LLM client.
const calls = [];
let script = [];

vi.mock("../llm-provider.js", () => ({
  detectProvider: () => "openrouter",
  createLLMClient: async () => ({
    chat: { completions: { create: async (body) => {
      calls.push(body);
      const next = script.shift();
      return next ?? { choices: [{ message: { content: "fallback" } }] };
    } } },
  }),
  getProviderFeatures: () => ({ systemRole: true, toolChoice: true }),
  handleProviderError: () => ({ type: "unknown", shouldRetry: false }),
  markLlmSuccess: () => {},
  getLastLlmSuccessTs: () => null,
}));
vi.mock("../prompt.js", () => ({ buildSystemPrompt: () => "sys" }));
vi.mock("../tools/executor.js", () => ({ executeTool: async () => ({ result: "ok" }) }));
vi.mock("../tools/definitions.js", () => ({ tools: [{ function: { name: "get_token_info" } }] }));
vi.mock("../tools/wallet.js", () => ({ getWalletBalances: async () => ({}) }));
vi.mock("../state.js", () => ({ getStateSummary: () => ({ positions: [], open_positions: 0, closed_positions: 0 }) }));
vi.mock("../lessons.js", () => ({ getLessonsForPrompt: () => "", getPerformanceSummary: () => "No trades." }));
vi.mock("../logger.js", () => ({ log: () => {} }));
vi.mock("../config.js", () => ({
  config: { llm: { maxSteps: 5, maxTokens: 4096, temperature: 0.7, generalModel: "openrouter/auto" }, vault: {}, risk: {} },
}));

const { agentLoop } = await import("../agent.js");

const EMPTY = () => ({ choices: [{ message: { content: "" } }] });

describe("agentLoop — empty-response resilience", () => {
  it("salvages reasoning_content when content is empty", async () => {
    calls.length = 0;
    script = [{ choices: [{ message: { content: "", reasoning_content: "Jawaban dari reasoning." } }] }];
    const r = await agentLoop("halo apa kabar", 3, [], "GENERAL");
    expect(r.content).toBe("Jawaban dari reasoning.");
  });

  it("drops tools on retry after an empty response, then succeeds", async () => {
    calls.length = 0;
    script = [EMPTY(), { choices: [{ message: { content: "Jawaban kedua." } }] }];
    const r = await agentLoop("halo apa kabar", 4, [], "GENERAL");
    expect(r.content).toBe("Jawaban kedua.");
    expect(calls.length).toBe(2);
    expect(calls[0].tools).toBeTruthy();      // first attempt carries tools
    expect(calls[1].tools).toBeUndefined();   // retry is chat-only
  });

  it("still gives up with the sentinel after 3 empties", async () => {
    calls.length = 0;
    script = [EMPTY(), EMPTY(), EMPTY()];
    const r = await agentLoop("halo apa kabar", 5, [], "GENERAL");
    expect(r.content).toBe("No response from model.");
  });
});
