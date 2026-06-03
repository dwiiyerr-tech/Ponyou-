import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { color, glyph } from "../theme.js";

/**
 * The four states every data view must handle (Emil: clear loading / empty /
 * error / success). Keeping them as one tiny module guarantees they look
 * identical everywhere — the kind of invisible consistency that compounds.
 */

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <Box>
      {/* Fast spinner reads as "fast app" even when load time is identical. */}
      <Text color={color.accent}><Spinner type="dots" /></Text>
      <Text color={color.dim}> {label}…</Text>
    </Box>
  );
}

export function Empty({ message, hint }: { message: string; hint?: string }) {
  return (
    <Box flexDirection="column">
      <Text color={color.faint}>{glyph.dot} {message}</Text>
      {hint && <Text color={color.faint}>  {hint}</Text>}
    </Box>
  );
}

export function ErrorView({ message }: { message: string }) {
  return (
    <Box>
      <Text color={color.danger} bold>{glyph.err} </Text>
      <Text color={color.danger}>{message}</Text>
    </Box>
  );
}

export function Success({ message }: { message: string }) {
  return (
    <Box>
      <Text color={color.good} bold>{glyph.ok} </Text>
      <Text color={color.good}>{message}</Text>
    </Box>
  );
}
