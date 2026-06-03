import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.js";

interface PanelProps {
  title?: string;
  active?: boolean;
  children: React.ReactNode;
  width?: number | string;
  flexGrow?: number;
  /** Right-aligned hint shown next to the title. */
  hint?: string;
}

/**
 * Panel — the single bordered container used across every screen.
 * Consistent padding + title styling so the whole app reads as one voice.
 * Active panels get the accent border; everything else stays neutral.
 */
export function Panel({ title, active = false, children, width, flexGrow, hint }: PanelProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? color.borderActive : color.border}
      paddingX={1}
      width={width}
      flexGrow={flexGrow}
    >
      {title && (
        <Box justifyContent="space-between" marginBottom={1}>
          <Text bold color={active ? color.accent : color.dim}>
            {title.toUpperCase()}
          </Text>
          {hint && <Text color={color.faint}>{hint}</Text>}
        </Box>
      )}
      {children}
    </Box>
  );
}
