/**
 * theme.ts — design tokens for the Ponyou TUI (Design Spec v2).
 *
 * Philosophy (Emil Kowalski, adapted to terminals):
 *  - One accent colour. Everything else is neutral or semantic.
 *  - Hierarchy via weight (bold) + dim, not via many colours.
 *  - Own the palette: exact hex (truecolor). Ink downsamples to 256/16 on
 *    poorer terminals, so Termux still looks intentional, never accidental.
 *  - Semantic colours map to meaning, never decoration.
 */

export const color = {
  // Single accent — used sparingly for focus, active tab, the brand mark.
  accent: "#22D3EE", // brand cyan
  accentDim: "#0E7490", // de-emphasised accent (inactive rail / underglow)

  // Neutrals — the bulk of the UI lives here.
  // Soft white, not pure #FFF: leaves headroom so bold can read as "brighter".
  text: "#E5E7EB",
  dim: "#9CA3AF",
  faint: "#4B5563",
  bg: "#0B0F14", // reference background (assumed, never painted)

  // Semantic — meaning, not decoration.
  good: "#34D399",
  warn: "#FBBF24",
  danger: "#F87171",
  info: "#60A5FA",
  trade: "#C084FC",

  border: "#4B5563",
  borderActive: "#22D3EE",
} as const;

/** Brand wordmark gradient stops (left → right). */
export const brandGradient = ["#22D3EE", "#38BDF8", "#818CF8"] as const;

/** Log severity → colour. Mirrors the bot's log tag taxonomy. */
export const severityColor: Record<string, string> = {
  ERROR: color.danger,
  RISK: color.danger,
  WARN: color.warn,
  SIGNAL: color.warn,
  TRADE: color.trade,
  WALLET: color.good,
  SYSTEM: color.good,
  SCAN: color.accent,
  DEX: color.accent,
  TOOL: color.info,
  INFO: color.text,
};

/** Map a free-form log tag to a known severity colour. */
export function colorForTag(tag: string): string {
  const t = (tag || "").toUpperCase();
  if (severityColor[t]) return severityColor[t];
  if (/ERR|FAIL|CRIT/.test(t)) return color.danger;
  if (/WARN|RISK/.test(t)) return color.warn;
  if (/TRADE|SWAP|BUY|SELL/.test(t)) return color.trade;
  if (/SCAN|SCREEN|HUNT/.test(t)) return color.accent;
  if (/WALLET|VAULT|PNL/.test(t)) return color.good;
  return color.dim;
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
  pending: "◇",
  cursor: "▸",
  dot: "·",
  arrowR: "→",
  sep: "│",
  bullet: "•",
  brand: "◆",
  gain: "▲",
  loss: "▼",
  flat: "─",
  rule: "─",
  corner: "└",
  spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  /** Partial-cell horizontal bar fills (1/8 increments). */
  barFill: ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"],
  barEmpty: "░",
} as const;

/** Responsive breakpoint — below this width we switch to a compact layout. */
export const COMPACT_WIDTH = 72;

/** Risk band → label + colour. Single source of truth for risk styling. */
export function riskStyle(score: number): { label: string; color: string } {
  if (score >= 70) return { label: "HIGH", color: color.danger };
  if (score >= 40) return { label: "MED", color: color.warn };
  return { label: "LOW", color: color.good };
}

// ─── Pure render helpers (unit-tested) ──────────────────────────────────────

/**
 * sparkline — map a numeric series onto block glyphs ▁▂▃▄▅▆▇█.
 * Scales to the series' own min/max so small drifts stay visible. An empty or
 * single-value series renders a flat baseline (no fake variance).
 */
export function sparkline(values: number[], width = 0): string {
  if (!values || values.length === 0) return "";
  const series = width > 0 ? values.slice(-width) : values;
  if (series.length === 1) return glyph.spark[0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  return series
    .map((v) => {
      if (!Number.isFinite(span) || span === 0) return glyph.spark[0]; // flat or all-NaN
      const idx = Math.round(((v - min) / span) * (glyph.spark.length - 1));
      return glyph.spark[Math.max(0, Math.min(glyph.spark.length - 1, idx))];
    })
    .join("");
}

/** Linear-interpolate a hex colour between two `#RRGGBB` stops at t∈[0,1]. */
function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const mix = pa.map((c, i) => Math.round(c + (pb[i] - c) * t));
  return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/**
 * gradientColors — `n` evenly-spaced colours spanning `stops`. Used to paint
 * the brand wordmark per-character. With one stop it returns that colour `n`
 * times; with n=1 it returns the first stop.
 */
export function gradientColors(n: number, stops: readonly string[] = brandGradient): string[] {
  if (n <= 0) return [];
  if (stops.length === 1 || n === 1) return Array.from({ length: n }, () => stops[0]);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const pos = (i / (n - 1)) * (stops.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(stops.length - 1, lo + 1);
    out.push(lerpHex(stops[lo], stops[hi], pos - lo));
  }
  return out;
}

/**
 * bar — a horizontal meter `value/max` rendered in `width` cells with
 * 1/8-cell precision, padded with the empty glyph. Used for win-rate, chain
 * heat, and per-position P&L meters.
 */
export function bar(value: number, max: number, width: number): string {
  if (width <= 0) return "";
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const totalEighths = Math.round(ratio * width * 8);
  const full = Math.floor(totalEighths / 8);
  const rem = totalEighths % 8;
  let out = "█".repeat(Math.min(full, width));
  if (full < width && rem > 0) out += glyph.barFill[rem];
  return out.padEnd(width, glyph.barEmpty);
}
