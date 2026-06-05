import React from "react";
import { Text } from "ink";
import { bar, glyph, color } from "../theme.js";

/**
 * MeterBar — a horizontal meter rendered with 1/8-cell precision. The filled
 * portion takes the supplied colour; the empty track stays faint so the bar
 * reads as a single quiet object, not two competing ones.
 */
export function MeterBar({
  value,
  max,
  width = 10,
  color: c = color.accent,
}: {
  value: number;
  max: number;
  width?: number;
  color?: string;
}) {
  const rendered = bar(value, max, width);
  // Split into filled vs empty so each gets its own colour.
  const emptyCount = rendered.split("").filter((ch) => ch === glyph.barEmpty).length;
  const filled = rendered.slice(0, rendered.length - emptyCount);
  const empty = glyph.barEmpty.repeat(emptyCount);
  return (
    <Text>
      <Text color={c}>{filled}</Text>
      <Text color={color.faint}>{empty}</Text>
    </Text>
  );
}
