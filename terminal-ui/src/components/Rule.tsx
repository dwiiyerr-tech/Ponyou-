import React from "react";
import { Text } from "ink";
import { color } from "../theme.js";

/**
 * Rule — a full-width horizontal divider for in-panel section breaks. Cheaper
 * on the eye than nesting another bordered box. Optionally carries a small
 * label that sits flush-left in the rule (e.g. "OPEN POSITIONS").
 */
export function Rule({
  width,
  label,
  color: c = color.faint,
}: {
  width: number;
  label?: string;
  color?: string;
}) {
  // Target one cell short of the box so wrap="truncate" never trims a glyph
  // (which would leave an ugly trailing "…"); the 1-cell gap reads as flush.
  const w = Math.max(1, width - 1);
  if (!label) return <Text color={c} wrap="truncate">{"─".repeat(w)}</Text>;
  const head = `─ ${label} `;
  const tail = Math.max(0, w - head.length);
  return (
    <Text color={c} wrap="truncate">
      ─ <Text color={color.dim}>{label}</Text> {"─".repeat(tail)}
    </Text>
  );
}
