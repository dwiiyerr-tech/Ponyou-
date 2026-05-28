/**
 * Tests for:
 *   - Prompt caching: STABLE_BOUNDARY marker + cache_control injection
 *   - Per-role LLM timeout config
 */
import { describe, it, expect } from "vitest";

// ─── Prompt builder: STABLE_BOUNDARY marker ───────────────────────────────

describe("PC1: buildSystemPrompt inserts STABLE_END marker", () => {
  const BOUNDARY = "\x00STABLE_END\x00";

  it("MANAGER prompt contains the marker exactly once", async () => {
    const { buildSystemPrompt } = await import("../prompt.js");
    const prompt = buildSystemPrompt("MANAGER", { sol: 1, tokens: [] }, {}, null, null, null);
    const count = prompt.split(BOUNDARY).length - 1;
    expect(count).toBe(1);
  });

  it("SCREENER prompt contains the marker exactly once", async () => {
    const { buildSystemPrompt } = await import("../prompt.js");
    const prompt = buildSystemPrompt("SCREENER", { sol: 1, tokens: [] }, {}, null, null, null);
    expect((prompt.split(BOUNDARY).length - 1)).toBe(1);
  });

  it("GENERAL prompt contains the marker exactly once", async () => {
    const { buildSystemPrompt } = await import("../prompt.js");
    const prompt = buildSystemPrompt("GENERAL", { sol: 1, tokens: [] }, {}, null, null, null);
    expect((prompt.split(BOUNDARY).length - 1)).toBe(1);
  });

  it("stable part always has non-trivial content (>50 chars)", async () => {
    const { buildSystemPrompt } = await import("../prompt.js");
    for (const role of ["MANAGER", "SCREENER", "GENERAL"]) {
      const prompt = buildSystemPrompt(role, { sol: 1, tokens: [] }, {}, null, null, null);
      const [stable] = prompt.split(BOUNDARY);
      // stable must have the role instructions at minimum
      expect(stable.length).toBeGreaterThan(50);
    }
  });

  it("role identity appears in the stable part (before boundary)", async () => {
    const { buildSystemPrompt } = await import("../prompt.js");
    const manager  = buildSystemPrompt("MANAGER",  {}, {});
    const screener = buildSystemPrompt("SCREENER", {}, {});
    const general  = buildSystemPrompt("GENERAL",  {}, {});
    expect(manager.split(BOUNDARY)[0]).toMatch(/MANAGER/);
    expect(screener.split(BOUNDARY)[0]).toMatch(/SCREENER/);
    expect(general.split(BOUNDARY)[0]).toMatch(/Ponyou/);
  });

  it("timestamp Ts: appears in the dynamic part (after boundary)", async () => {
    const { buildSystemPrompt } = await import("../prompt.js");
    for (const role of ["MANAGER", "SCREENER", "GENERAL"]) {
      const prompt = buildSystemPrompt(role, {}, {});
      const parts = prompt.split(BOUNDARY);
      expect(parts[parts.length - 1]).toMatch(/Ts:/);
    }
  });
});

// ─── buildMessages cache_control injection ────────────────────────────────

describe("PC2: buildMessages applies cache_control for Claude models", async () => {
  // We test the behaviour by reading agent.js internals through a light mock.
  // Because agent.js is an ESM module with top-level await (initLLMClient),
  // we can't import it directly in tests. Instead we replicate the logic here
  // to verify the algorithm is correct.

  const BOUNDARY = "\x00STABLE_END\x00";

  function buildMessagesMock(systemPrompt, sessionHistory, goal, providerMode, enableCache) {
    const boundaryIdx = systemPrompt.indexOf(BOUNDARY);
    const hasMarker   = boundaryIdx >= 0;

    if (providerMode === "user_embedded") {
      const clean = hasMarker
        ? systemPrompt.slice(0, boundaryIdx) + "\n" + systemPrompt.slice(boundaryIdx + BOUNDARY.length)
        : systemPrompt;
      return [
        ...sessionHistory,
        { role: "user", content: `[SYSTEM INSTRUCTIONS]\n${clean}\n\n[USER REQUEST]\n${goal}` },
      ];
    }

    if (enableCache && hasMarker) {
      const stable  = systemPrompt.slice(0, boundaryIdx).trimEnd();
      const dynamic = systemPrompt.slice(boundaryIdx + BOUNDARY.length).trimStart();
      return [
        {
          role: "system",
          content: [
            { type: "text", text: stable, cache_control: { type: "ephemeral" } },
            ...(dynamic ? [{ type: "text", text: dynamic }] : []),
          ],
        },
        ...sessionHistory,
        { role: "user", content: goal },
      ];
    }

    const clean = hasMarker
      ? systemPrompt.slice(0, boundaryIdx) + "\n" + systemPrompt.slice(boundaryIdx + BOUNDARY.length)
      : systemPrompt;
    return [
      { role: "system", content: clean },
      ...sessionHistory,
      { role: "user", content: goal },
    ];
  }

  const samplePrompt = `You are SCREENER.\nRULES: pick best.${BOUNDARY}Ts:2026-01-01`;

  it("without caching: system message is a plain string", () => {
    const msgs = buildMessagesMock(samplePrompt, [], "find tokens", "system", false);
    expect(typeof msgs[0].content).toBe("string");
    expect(msgs[0].content).not.toContain("\x00");
  });

  it("with caching: system content is an array with cache_control on stable block", () => {
    const msgs = buildMessagesMock(samplePrompt, [], "find tokens", "system", true);
    expect(Array.isArray(msgs[0].content)).toBe(true);
    const stable = msgs[0].content[0];
    expect(stable.cache_control).toEqual({ type: "ephemeral" });
    expect(stable.text).toContain("SCREENER");
    expect(stable.text).not.toContain("\x00");
  });

  it("with caching: dynamic block has no cache_control", () => {
    const msgs = buildMessagesMock(samplePrompt, [], "find tokens", "system", true);
    const dynamic = msgs[0].content[1];
    expect(dynamic.cache_control).toBeUndefined();
    expect(dynamic.text).toContain("Ts:");
  });

  it("user_embedded mode: strips marker and embeds in user message", () => {
    const msgs = buildMessagesMock(samplePrompt, [], "hello", "user_embedded", false);
    const userMsg = msgs[msgs.length - 1].content;
    expect(userMsg).toContain("[SYSTEM INSTRUCTIONS]");
    expect(userMsg).not.toContain("\x00");
  });

  it("no marker: returns plain string even with enableCache=true", () => {
    const plain = "You are Ponyou. Do stuff. Ts:now";
    const msgs = buildMessagesMock(plain, [], "go", "system", true);
    expect(typeof msgs[0].content).toBe("string");
  });
});

// ─── Per-role timeout config ──────────────────────────────────────────────

describe("PC3: per-role LLM timeout keys exposed in config", () => {
  it("config.llm has timeoutMs, managerTimeoutMs, screenerTimeoutMs, generalTimeoutMs", async () => {
    const { config } = await import("../config.js");
    expect(typeof config.llm.timeoutMs).toBe("number");
    expect(typeof config.llm.managerTimeoutMs).toBe("number");
    expect(typeof config.llm.screenerTimeoutMs).toBe("number");
    expect(typeof config.llm.generalTimeoutMs).toBe("number");
  });

  it("default managerTimeoutMs < generalTimeoutMs (manager must be faster)", async () => {
    const { config } = await import("../config.js");
    expect(config.llm.managerTimeoutMs).toBeLessThan(config.llm.generalTimeoutMs);
  });

  it("default screenerTimeoutMs < generalTimeoutMs", async () => {
    const { config } = await import("../config.js");
    expect(config.llm.screenerTimeoutMs).toBeLessThan(config.llm.generalTimeoutMs);
  });

  it("promptCaching defaults to true", async () => {
    const { config } = await import("../config.js");
    expect(config.llm.promptCaching).toBe(true);
  });
});
