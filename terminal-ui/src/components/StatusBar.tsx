import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.js";

interface Hint { key: string; label: string; }

/**
 * StatusBar — a single line of keyboard hints. Keyboard-first apps must always
 * tell you what the keys do; this is the persistent affordance. Transient
 * toasts (success/error) take over this line briefly, then it returns to hints.
 */
export function StatusBar({
  hints,
  toast,
}: {
  hints: Hint[];
  toast?: { kind: "success" | "error" | "info"; message: string } | null;
}) {
  if (toast) {
    const c = toast.kind === "success" ? color.good : toast.kind === "error" ? color.danger : color.accent;
    const g = toast.kind === "success" ? glyph.ok : toast.kind === "error" ? glyph.err : glyph.dot;
    return (
      <Box paddingX={1}>
        <Text color={c} bold>{g} </Text>
        <Text color={c}>{toast.message}</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      {hints.map((h, i) => (
        <Box key={i} marginRight={2}>
          <Text color={color.accent}>{h.key}</Text>
          <Text color={color.faint}> {h.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
