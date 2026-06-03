import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.js";

interface HeaderProps {
  agentName: string;
  mode: string;
  connected: boolean;
  compact: boolean;
}

/**
 * Header — brand mark + agent identity + a live/idle connection dot.
 * The dot is the only colour change here; everything else is calm neutral
 * so the eye lands on status, not chrome.
 */
export function Header({ agentName, mode, connected, compact }: HeaderProps) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text bold color={color.accent}>ponyou</Text>
        {!compact && <Text color={color.faint}> {glyph.dot} memecoin agent</Text>}
      </Box>
      <Box>
        <Text color={connected ? color.good : color.faint}>
          {connected ? glyph.live : glyph.idle}
        </Text>
        <Text color={color.dim}> {connected ? "live" : "file"}</Text>
        <Text color={color.faint}>  {glyph.dot}  </Text>
        <Text color={mode === "live" ? color.warn : color.dim}>{mode}</Text>
        {!compact && <Text color={color.faint}>  {glyph.dot}  {agentName}</Text>}
      </Box>
    </Box>
  );
}
