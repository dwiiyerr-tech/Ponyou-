/**
 * theme.ts — design tokens for the Ponyou TUI.
 *
 * Philosophy (Emil Kowalski, adapted to terminals):
 *  - One accent colour. Everything else is neutral or semantic.
 *  - Hierarchy via weight (bold) + dim, not via many colours.
 *  - Consistent spacing scale so nothing feels arbitrary.
 *  - Semantic colours map to meaning, never decoration.
 */

export const color = {
  // Single accent — used sparingly for focus, active tab, the brand mark.
  accent: "cyan",

  // Neutrals — the bulk of the UI lives here.
  text: "white",
  dim: "gray",
  faint: "gray",

  // Semantic — meaning, not decoration.
  good: "green",
  warn: "yellow",
  danger: "red",
  info: "blue",
  trade: "magenta",

  border: "gray",
  borderActive: "cyan",
} as const;

/** Log severity → colour. Mirrors the bot's log tag taxonomy. */
export const severityColor: Record<string, string> = {
  ERROR: "red",
  RISK: "red",
  WARN: "yellow",
  SIGNAL: "yellow",
  TRADE: "magenta",
  WALLET: "green",
  SYSTEM: "green",
  SCAN: "cyan",
  DEX: "cyan",
  TOOL: "blue",
  INFO: "white",
};

/** Map a free-form log tag to a known severity colour. */
export function colorForTag(tag: string): string {
  const t = (tag || "").toUpperCase();
  if (severityColor[t]) return severityColor[t];
  if (/ERR|FAIL|CRIT/.test(t)) return "red";
  if (/WARN|RISK/.test(t)) return "yellow";
  if (/TRADE|SWAP|BUY|SELL/.test(t)) return "magenta";
  if (/SCAN|SCREEN|HUNT/.test(t)) return "cyan";
  if (/WALLET|VAULT|PNL/.test(t)) return "green";
  return "gray";
}

/** Spacing scale (terminal rows/cols). Keep choices to this set. */
export const space = { xs: 1, sm: 1, md: 2, lg: 3 } as const;

/** Glyphs — one consistent set so the UI reads as a single voice. */
export const glyph = {
  live: "●",
  idle: "○",
  ok: "✓",
  warn: "▲",
  err: "✕",
  cursor: "▸",
  dot: "·",
  arrowR: "→",
  spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
} as const;

/** Responsive breakpoint — below this width we switch to a compact layout. */
export const COMPACT_WIDTH = 72;

/** Risk band → label + colour. Single source of truth for risk styling. */
export function riskStyle(score: number): { label: string; color: string } {
  if (score >= 70) return { label: "HIGH", color: "red" };
  if (score >= 40) return { label: "MED", color: "yellow" };
  return { label: "LOW", color: "green" };
}
