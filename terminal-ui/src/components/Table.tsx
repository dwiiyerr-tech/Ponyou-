import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.js";

export interface Column<T> {
  key: string;
  header: string;
  width: number;
  align?: "left" | "right";
  /** Render the cell; return a string. */
  render: (row: T) => string;
  /** Optional per-cell colour. */
  color?: (row: T) => string;
  /** Hide this column in compact mode. */
  compactHide?: boolean;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  selectedIndex?: number;
  compact?: boolean;
}

function pad(s: string, width: number, align: "left" | "right"): string {
  const clipped = s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s;
  return align === "right" ? clipped.padStart(width) : clipped.padEnd(width);
}

/**
 * Table — fixed-width columns with a keyboard selection cursor.
 * Columns marked compactHide drop out on narrow terminals so the table
 * never wraps or overflows on a phone/tablet width.
 */
export function Table<T>({ columns, rows, selectedIndex = -1, compact = false }: TableProps<T>) {
  const cols = compact ? columns.filter((c) => !c.compactHide) : columns;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text> </Text>
        {cols.map((c) => (
          <Text key={c.key} color={color.faint}>
            {pad(c.header, c.width, c.align || "left")}{" "}
          </Text>
        ))}
      </Box>

      {/* Rows */}
      {rows.map((row, i) => {
        const selected = i === selectedIndex;
        return (
          <Box key={i}>
            <Text color={color.accent}>{selected ? glyph.cursor : " "}</Text>
            {cols.map((c) => (
              <Text
                key={c.key}
                color={c.color ? c.color(row) : selected ? color.text : color.dim}
                bold={selected}
              >
                {pad(c.render(row), c.width, c.align || "left")}{" "}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
