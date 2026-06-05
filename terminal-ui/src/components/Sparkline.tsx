import React from "react";
import { Text } from "ink";
import { sparkline, color } from "../theme.js";

/**
 * Sparkline — a one-line block-glyph chart of a numeric series. Scales to the
 * series' own range so small drifts stay legible. No animation: it just redraws
 * on each data tick (the value IS the signal). Empty series render nothing so
 * callers can show their own placeholder.
 */
export function Sparkline({
  values,
  width = 8,
  color: c = color.accent,
}: {
  values: number[];
  width?: number;
  color?: string;
}) {
  const spark = sparkline(values, width);
  if (!spark) return null;
  return <Text color={c}>{spark}</Text>;
}
