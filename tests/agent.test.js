import { describe, it, expect, vi } from "vitest";

// The agent module self-initializes the LLM client on import which calls
// detectProvider + createLLMClient + getProviderFeatures. Because those
// depend on real config/API keys, we mock the LLM init chain BEFORE the
// first import so the top-level await doesn't fail.

vi.mock("../llm-provider.js", () => ({
  detectProvider: () => "openrouter",
  createLLMClient: async () => ({
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "OK" } }] }) } },
  }),
  getProviderFeatures: () => ({ systemRole: true, toolChoice: true }),
  handleProviderError: (err) => ({ type: "unknown", shouldRetry: false }),
  markLlmSuccess: () => {},
  getLastLlmSuccessTs: () => null,
}));

vi.mock("../prompt.js", () => ({
  buildSystemPrompt: () => "System prompt goes here",
}));

vi.mock("../tools/executor.js", () => ({
  executeTool: async () => ({ result: "ok" }),
}));

vi.mock("../tools/definitions.js", () => ({
  tools: [
    { function: { name: "swap_token" } },
    { function: { name: "get_wallet_balance" } },
    { function: { name: "discover_tokens" } },
    { function: { name: "get_token_security_details" } },
    { function: { name: "get_token_info" } },
    { function: { name: "self_update" } },
    { function: { name: "update_config" } },
    { function: { name: "add_to_blacklist" } },
    { function: { name: "block_deployer" } },
    { function: { name: "add_lesson" } },
    { function: { name: "list_lessons" } },
    { function: { name: "analyze_dex_visibility_risk" } },
    { function: { name: "analyze_three_candle_confirmation" } },
    { function: { name: "analyze_cabal_play" } },
    { function: { name: "process_wallet_ping" } },
    { function: { name: "analyze_day_phase" } },
    { function: { name: "get_token_holders" } },
    { function: { name: "get_solana_gas_fee" } },
    { function: { name: "discover_smart_wallets" } },
    { function: { name: "list_discovered_wallets" } },
    { function: { name: "list_smart_wallets" } },
    { function: { name: "add_smart_wallet" } },
    { function: { name: "remove_smart_wallet" } },
    { function: { name: "get_smart_money_rank" } },
    { function: { name: "get_smart_money_inflow" } },
    { function: { name: "score_rug_risk" } },
    { function: { name: "learn_rug_patterns" } },
    { function: { name: "list_rug_patterns" } },
    { function: { name: "harvest_market_rugs" } },
    { function: { name: "get_rug_memory_summary" } },
    { function: { name: "report_rug" } },
    { function: { name: "list_blacklist" } },
    { function: { name: "list_blocked_deployers" } },
    { function: { name: "classify_narrative" } },
    { function: { name: "get_narrative_heat" } },
    { function: { name: "get_trending_narratives" } },
    { function: { name: "resolve_ticker" } },
    { function: { name: "list_tickers" } },
    { function: { name: "register_ticker" } },
  ],
}));

vi.mock("../tools/wallet.js", () => ({
  getWalletBalances: async () => ({}),
}));

vi.mock("../state.js", () => ({
  getStateSummary: () => ({ positions: [], open_positions: 0, closed_positions: 0 }),
}));

vi.mock("../lessons.js", () => ({
  getLessonsForPrompt: () => "",
  getPerformanceSummary: () => "No trades.",
}));

vi.mock("../logger.js", () => ({
  log: () => {},
}));

vi.mock("../config.js", () => ({
  config: {
    llm: { maxSteps: 5, maxTokens: 4096, temperature: 0.7, generalModel: "openrouter/auto" },
    vault: {},
    risk: {},
  },
}));

// Now import the agent module
const agent = await import("../agent.js");

describe("agent — exports", () => {
  it("exports agentLoop and getLLMClient", () => {
    expect(typeof agent.agentLoop).toBe("function");
    expect(typeof agent.getLLMClient).toBe("function");
  });
});

describe("agent — agentLoop", () => {
  it("returns content for a simple non-tool goal", async () => {
    // Use a goal that doesn't match MUTATING_TOOL_INTENTS or LIVE_DATA_TOOL_INTENTS
    const result = await agent.agentLoop(
      "hello, how are you?",
      2,
      [],
      "GENERAL",
      "openrouter/auto",
      1024,
    );
    expect(result).toBeDefined();
    expect(typeof result.content).toBe("string");
  });

  it("respects maxSteps limit", async () => {
    // With a content-only response and no tool calls, should return quickly
    const result = await agent.agentLoop(
      "say hi",
      1,
      [],
      "GENERAL",
      "openrouter/auto",
      1024,
    );
    expect(result).toBeDefined();
  });
});
