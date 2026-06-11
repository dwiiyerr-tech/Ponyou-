/**
 * Mono Terminal design system (task #12): recurring notifications share one
 * visual language — bold uppercase title with interpunct context, aligned
 * label/value columns inside <pre>, outcome emoji (🟢/🔴) only.
 */
import { describe, it, expect } from "vitest";
import { fmt } from "../telegram.js";
import { formatReportTelegram } from "../daily-report.js";

describe("fmt.title", () => {
  it("uppercases and joins with interpunct", () => {
    expect(fmt.title("Close", "MOON", "🟢")).toBe("<b>CLOSE</b> · MOON  🟢");
  });
  it("works without context or icon", () => {
    expect(fmt.title("Status")).toBe("<b>STATUS</b>");
  });
  it("escapes HTML in title and context", () => {
    expect(fmt.title("a<b", "x&y")).toBe("<b>A&lt;B</b> · x&amp;y");
  });
});

describe("fmt.monoBlock", () => {
  it("aligns value columns across rows", () => {
    const out = fmt.monoBlock([["pnl", "+24.36%"], ["hold", "18m"]]);
    expect(out.startsWith("<pre>")).toBe(true);
    const [l1, l2] = out.replace(/<\/?pre>/g, "").split("\n");
    expect(l1.indexOf("+24.36%")).toBe(l2.indexOf("18m"));
  });
  it("skips empty values and returns empty string for no rows", () => {
    expect(fmt.monoBlock([["a", ""], ["b", null]])).toBe("");
    expect(fmt.monoBlock([])).toBe("");
  });
  it("escapes content inside the block", () => {
    const out = fmt.monoBlock([["x", "<5%"]]);
    expect(out).toContain("&lt;5%");
    expect(out).not.toContain("<5%");
  });
});

describe("formatReportTelegram — mono style", () => {
  const report = {
    date: "2026-06-11",
    plan: { day: 12, days_total: 30, target_pct: 25, achieved_today: false, pnl_pct: 1.2, start_usd: 100, end_usd: 101.2, win_rate_days: "4/11", days_completed: 11 },
    trades: { stats: { total: 7, wins: 1, losses: 6, rugs: 0, win_rate_pct: 14.3, avg_pnl_pct: -12.4, avg_hold_min: 22, best_trade: { symbol: "2he", pnl_pct: 28.6 }, worst_trade: { symbol: "ABEL", pnl_pct: -98.01 } } },
    market: { current_condition: "NORMAL", trend: "flat" },
    learning: { events_total: 3, analyses_total: 2, recent_analyses: [{ symbol: "MOON", pnl_pct: 21.8, lessons_count: 2 }] },
    vault: { configured: false },
  };

  it("renders title, divider, and aligned pre blocks", () => {
    const out = formatReportTelegram(report);
    expect(out).toContain("<b>LAPORAN HARIAN</b> · 2026-06-11");
    expect(out).toContain("<b>TRADES</b> · 24h");
    expect((out.match(/<pre>/g) || []).length).toBeGreaterThanOrEqual(2);
    // no legacy emoji clutter
    for (const e of ["📊", "📈", "🌡️", "🧠", "🏦", "🏆", "💀"]) {
      expect(out).not.toContain(e);
    }
  });

  it("handles a no-trade day without crashing", () => {
    const out = formatReportTelegram({ ...report, plan: null, trades: { stats: null }, learning: { events_total: 0, recent_analyses: [] } });
    expect(out).toContain("tidak ada trade");
  });
});
