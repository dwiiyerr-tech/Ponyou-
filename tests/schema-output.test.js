import { describe, expect, it } from "vitest";
import { buildLossAnalysisPrompt } from "../learning-mode.js";
import { buildObservationAnalysisPrompt, buildSuccessAnalysisPrompt } from "../learning-continuous.js";
import { tryParseStructuredOutput, validateStructuredOutput } from "../structured-output.js";

describe("schema-first prompts", () => {
  it("adds explicit output schema to loss analysis", () => {
    const prompt = buildLossAnalysisPrompt({ symbol: "AAA", mint: "mint" }, []);
    expect(prompt).toContain("OUTPUT_SCHEMA");
    expect(prompt).toContain("JSON valid");
  });

  it("adds explicit output schema to observation analysis", () => {
    const prompt = buildObservationAnalysisPrompt([{ performance: "GEM", symbol: "AAA", change_pct: 120, passed: true, flags: [] }]);
    expect(prompt).toContain("OUTPUT_SCHEMA");
    expect(prompt).toContain("JSON valid");
  });

  it("adds explicit output schema to success analysis", () => {
    const prompt = buildSuccessAnalysisPrompt({ symbol: "AAA", mint: "mint", pnl_pct: 25, hold_minutes: 12 });
    expect(prompt).toContain("OUTPUT_SCHEMA");
    expect(prompt).toContain("JSON valid");
  });

  it("rejects malformed structured output for loss analysis", () => {
    const parsed = tryParseStructuredOutput('{"root_cause":"single string","missed_flags":[],"avoid_pattern":[],"lessons":[],"confidence":88}');
    const validation = validateStructuredOutput("LOSS_ANALYSIS", parsed);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/root_cause/);
  });

  it("accepts a fully valid loss analysis shape", () => {
    const parsed = tryParseStructuredOutput('{"root_cause":["bad entry"],"missed_flags":["volume"],"avoid_pattern":["chase pumps"],"lessons":["wait for confirmation"],"confidence":82}');
    const validation = validateStructuredOutput("LOSS_ANALYSIS", parsed);
    expect(validation.ok).toBe(true);
    expect(validation.normalized.confidence).toBe(82);
    expect(validation.normalized.lessons).toEqual(["wait for confirmation"]);
  });

});
