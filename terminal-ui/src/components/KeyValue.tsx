import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.js";

interface Row {
  label: string;
  value: string;
  /** Optional colour for the value (semantic emphasis). */
  color?: string;
  bold?: boolean;
}

/**
 * KeyValue — aligned label/value rows. Labels are dim + fixed-width so values
 * line up into a clean column. Hierarchy comes from alignment, not borders.
 */
export function KeyValue({ rows, labelWidth = 14 }: { rows: Row[]; labelWidth?: number }) {
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => (
        <Box key={i}>
          <Box width={labelWidth}>
            <Text color={color.dim}>{r.label}</Text>
          </Box>
          <Text color={r.color || color.text} bold={r.bold}>
            {r.value}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
