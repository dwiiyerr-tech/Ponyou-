import { describe, it, expect, beforeEach } from "vitest";
import {
  optimizePrompt,
  clearPromptCache,
  getPromptCacheStats,
} from "../prompt-optimizer.js";

const BOUNDARY = "\x00STABLE_END\x00";

// ─── Helpers ─────────────────────────────────────────────────────────────

function makePrompt(stable, dynamic = "Ts:2026-01-01") {
  return `${stable}${BOUNDARY}${dynamic}`;
}

beforeEach(() => clearPromptCache());

// ─── Strategy 1: in-process cache ────────────────────────────────────────

describe("OPT1: in-process prompt cache", () => {
  it("returns fromCache=false on first call", () => {
    const r = optimizePrompt(makePrompt("You are SCREENER.\nRULES: pick best."), "SCREENER");
    expect(r.fromCache).toBe(false);
  });

  it("returns fromCache=true on identical second call within TTL", () => {
    const p = makePrompt("You are SCREENER.\nRULES: pick best.");
    optimizePrompt(p, "SCREENER");
    const r2 = optimizePrompt(p, "SCREENER");
    expect(r2.fromCache).toBe(true);
  });

  it("different role = different cache bucket, no false hit", () => {
    const p = makePrompt("You are SCREENER.\nRULES: pick best.");
    optimizePrompt(p, "SCREENER");
    const r = optimizePrompt(p, "MANAGER");
    expect(r.fromCache).toBe(false);
  });

  it("different prompt content = cache miss", () => {
    optimizePrompt(makePrompt("Prompt A"), "SCREENER");
    const r = optimizePrompt(makePrompt("Prompt B"), "SCREENER");
    expect(r.fromCache).toBe(false);
  });

  it("getPromptCacheStats reflects cached entries", () => {
    optimizePrompt(makePrompt("Hello"), "GENERAL");
    const stats = getPromptCacheStats();
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.roles).toContain("GENERAL");
  });

  it("clearPromptCache empties cache", () => {
    optimizePrompt(makePrompt("Hello"), "GENERAL");
    clearPromptCache();
    const stats = getPromptCacheStats();
    expect(stats.entries).toBe(0);
  });
});

// ─── Strategy 2: lesson truncation ───────────────────────────────────────

describe("OPT2: lesson truncation", () => {
  it("does not touch lessons under the cap", () => {
    const short = "LESSONS:lesson1\nlesson2";
    const p = makePrompt(`You are SCREENER.\n${short}`);
    const r = optimizePrompt(p, "SCREENER");
    expect(r.text).toContain("lesson1");
    expect(r.text).toContain("lesson2");
  });

  it("truncates lessons over cap, keeping tail", () => {
    const longLesson = "LESSONS:" + "x".repeat(900);  // 900 chars > LESSON_CHAR_CAP=800
    const p = makePrompt(`You are SCREENER.\n${longLesson}`);
    const r = optimizePrompt(p, "SCREENER");
    // Total lessons in result should be shorter
    const lessonIdx = r.text.indexOf("LESSONS:");
    const lessonSection = lessonIdx >= 0 ? r.text.slice(lessonIdx) : "";
    expect(lessonSection.length).toBeLessThan(longLesson.length);
    expect(r.savedTokens).toBeGreaterThan(0);
  });
});

// ─── Strategy 3: role-specific pruning ───────────────────────────────────

describe("OPT3: role-specific block pruning", () => {
  it("SCREENER: removes [VAULT] and [ATTRIBUTION] blocks", () => {
    const p = makePrompt(
      "You are SCREENER.\n[VAULT] 10% every 7d\n[ATTRIBUTION] hull=0.8\nRULES: go"
    );
    const r = optimizePrompt(p, "SCREENER");
    expect(r.text).not.toMatch(/\[VAULT\]/);
    expect(r.text).not.toMatch(/\[ATTRIBUTION\]/);
    expect(r.text).toContain("You are SCREENER");
  });

  it("MANAGER: removes [OUTPUT_SCHEMA] block", () => {
    const p = makePrompt("You are MANAGER.\n[OUTPUT_SCHEMA] {action:string}\nRULES: exit");
    const r = optimizePrompt(p, "MANAGER");
    expect(r.text).not.toMatch(/\[OUTPUT_SCHEMA\]/);
    expect(r.text).toContain("You are MANAGER");
  });

  it("GENERAL: removes [OUTPUT_SCHEMA] block", () => {
    const p = makePrompt("You are Ponyou.\n[OUTPUT_SCHEMA] {result:any}\nHandle requests.");
    const r = optimizePrompt(p, "GENERAL");
    expect(r.text).not.toMatch(/\[OUTPUT_SCHEMA\]/);
  });

  it("does not remove blocks that aren't in the prune list for that role", () => {
    const p = makePrompt("You are MANAGER.\n[MARKET] HOT | normal\nRULES: exit");
    const r = optimizePrompt(p, "MANAGER");
    expect(r.text).toContain("[MARKET]");
  });
});

// ─── Strategy 4: token budget enforcement ────────────────────────────────

describe("OPT4: token budget enforcement", () => {
  it("does not trim a prompt already within budget", () => {
    const short = makePrompt("You are SCREENER.\nRULES: go.");
    const r = optimizePrompt(short, "SCREENER");
    expect(r.text).toContain("RULES: go.");
  });

  it("trims lowest-priority blocks when over budget", () => {
    // Build a 10K-char prompt (well over any budget) to force trimming.
    const bigBlock = "[ATTRIBUTION] " + "a".repeat(4000) + "\n" +
                     "[VAULT] " + "b".repeat(4000) + "\n";
    const p = makePrompt(`You are SCREENER.\n${bigBlock}RULES: go.`);
    const r = optimizePrompt(p, "SCREENER");
    // At least one of the big low-priority blocks should be removed
    const hasAttr  = r.text.includes("[ATTRIBUTION]");
    const hasVault = r.text.includes("[VAULT]");
    expect(hasAttr || hasVault).toBe(false);
    expect(r.savedTokens).toBeGreaterThan(100);
  });
});

// ─── STABLE_BOUNDARY preservation ────────────────────────────────────────

describe("OPT5: STABLE_BOUNDARY marker preserved", () => {
  it("marker is still in result after optimization", () => {
    const p = makePrompt("You are SCREENER.\nRULES: go.", "Ts:now");
    const r = optimizePrompt(p, "SCREENER");
    expect(r.text).toContain(BOUNDARY);
  });

  it("stable and dynamic parts are in correct order", () => {
    const p = makePrompt("STABLE_CONTENT", "DYNAMIC_CONTENT");
    const r = optimizePrompt(p, "SCREENER");
    const idx = r.text.indexOf(BOUNDARY);
    expect(r.text.slice(0, idx)).toContain("STABLE_CONTENT");
    expect(r.text.slice(idx + BOUNDARY.length)).toContain("DYNAMIC_CONTENT");
  });

  it("prompt without marker passes through cleanly", () => {
    const plain = "You are Ponyou. No marker here. Ts:now";
    const r = optimizePrompt(plain, "GENERAL");
    expect(r.text).toContain("You are Ponyou");
    expect(r.text).not.toContain(BOUNDARY);
  });
});

// ─── Return shape ────────────────────────────────────────────────────────

describe("OPT6: return shape", () => {
  it("always returns { text, savedTokens, fromCache, originalTokens, finalTokens }", () => {
    const r = optimizePrompt("Hello world", "GENERAL");
    expect(typeof r.text).toBe("string");
    expect(typeof r.savedTokens).toBe("number");
    expect(typeof r.fromCache).toBe("boolean");
    expect(typeof r.originalTokens).toBe("number");
    expect(typeof r.finalTokens).toBe("number");
  });

  it("savedTokens >= 0 always", () => {
    const r = optimizePrompt(makePrompt("Short"), "MANAGER");
    expect(r.savedTokens).toBeGreaterThanOrEqual(0);
  });

  it("handles empty/null input without throwing", () => {
    expect(() => optimizePrompt("", "GENERAL")).not.toThrow();
    expect(() => optimizePrompt(null, "GENERAL")).not.toThrow();
  });
});
