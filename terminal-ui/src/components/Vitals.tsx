import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.js";

/**
 * Vital — one cell of the Monitor top strip: a dim label, one bold primary
 * value (the number you glance for), and an optional micro-viz line below
 * (sparkline / meter / sub-detail). Fixed min-width so the four cells align
 * into a clean row, then stack 2×2 in compact mode.
 */
export function Vital({
  label,
  value,
  valueColor = color.text,
  sub,
  width = 18,
}: {
  label: string;
  value: string;
  valueColor?: string;
  sub?: React.ReactNode;
  width?: number;
}) {
  return (
    <Box flexDirection="column" width={width} marginRight={1}>
      <Text color={color.dim}>{label}</Text>
      <Text color={valueColor} bold>{value}</Text>
      <Box>{sub ?? <Text> </Text>}</Box>
    </Box>
  );
}
