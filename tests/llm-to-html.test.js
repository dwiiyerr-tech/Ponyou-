/**
 * llmToTelegramHtml (task #12): LLM markdown must render as Telegram HTML,
 * not literal asterisk/heading/bullet characters. Crafted HTML passes through
 * untouched; everything else is escaped first so stray < > & can't break
 * parse_mode.
 */
import { describe, it, expect } from "vitest";
import { llmToTelegramHtml } from "../telegram.js";

describe("llmToTelegramHtml", () => {
  it("converts **bold**, headings, and bullets", () => {
    const out = llmToTelegramHtml("## Ringkasan\n**MOON** naik\n- entry ok\n- exit ok");
    expect(out).toContain("<b>Ringkasan</b>");
    expect(out).toContain("<b>MOON</b>");
    expect(out).toContain("• entry ok");
    expect(out).not.toContain("**");
    expect(out).not.toContain("##");
  });

  it("converts inline code and fenced blocks verbatim", () => {
    const out = llmToTelegramHtml("pakai `maxPositions`\n```\nconst x = 1 < 2;\n```");
    expect(out).toContain("<code>maxPositions</code>");
    expect(out).toContain("<pre>const x = 1 &lt; 2;</pre>");
  });

  it("strips <think> reasoning blocks", () => {
    const out = llmToTelegramHtml("<think>internal reasoning</think>Jawaban akhir");
    expect(out).toBe("Jawaban akhir");
  });

  it("escapes raw < > & so parse_mode HTML can't break", () => {
    const out = llmToTelegramHtml("PnL <5% & mcap >100K");
    expect(out).toContain("&lt;5%");
    expect(out).toContain("&gt;100K");
    expect(out).toContain("&amp;");
  });

  it("passes crafted HTML through untouched", () => {
    const html = "✅ <b>Disimpan</b>\n<code>x</code>";
    expect(llmToTelegramHtml(html)).toBe(html);
  });

  it("converts markdown links", () => {
    const out = llmToTelegramHtml("lihat [solscan](https://solscan.io/tx/abc)");
    expect(out).toContain('<a href="https://solscan.io/tx/abc">solscan</a>');
  });

  it("italic conversion does not eat multiplication or token names", () => {
    const out = llmToTelegramHtml("2*3*4 dan SOL*USDC tetap utuh, tapi *penting* miring");
    expect(out).toContain("<i>penting</i>");
    expect(out).toContain("2*3*4");
    expect(out).toContain("SOL*USDC");
  });

  it("collapses 3+ blank lines and trims", () => {
    const out = llmToTelegramHtml("a\n\n\n\nb");
    expect(out).toBe("a\n\nb");
  });

  it("handles empty/null", () => {
    expect(llmToTelegramHtml("")).toBe("");
    expect(llmToTelegramHtml(null)).toBe("");
  });

  it("numbers in plain text are not mistaken for code-block sentinels", () => {
    const out = llmToTelegramHtml("ada 3 token dan ```x``` satu blok");
    expect(out).toContain("ada 3 token");
    expect(out).toContain("<pre>x</pre>");
  });
});
