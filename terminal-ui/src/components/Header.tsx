import React from "react";
import { Box, Text } from "ink";
import { color, glyph, gradientColors } from "../theme.js";

interface HeaderProps {
  agentName: string;
  mode: string;
  connected: boolean;
  compact: boolean;
}

const WORDMARK = "ponyou";
// R6: guard against gradientColors returning fewer items than WORDMARK length
// (shouldn't happen with current theme, but defensive against future changes).
const _WM_GRAD = gradientColors(WORDMARK.length);
const WORDMARK_COLORS = WORDMARK.split("").map((_, i) => _WM_GRAD[i] ?? _WM_GRAD[_WM_GRAD.length - 1] ?? "#ffffff");

/**
 * Header — the brand moment + agent identity + a live/idle connection dot.
 * The wordmark is a per-character truecolor gradient (the one piece of pure
 * decoration in the app — a first frame that feels like a product). Everything
 * else stays calm neutral so the eye lands on the live dot, not the chrome.
 */
export function Header({ agentName, mode, connected, compact }: HeaderProps) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text color={color.accent}>{glyph.brand} </Text>
        <Text bold>
          {WORDMARK.split("").map((ch, i) => (
            <Text key={i} color={WORDMARK_COLORS[i]}>{ch}</Text>
          ))}
        </Text>
        {!compact && <Text color={color.faint}>  {glyph.dot} memecoin agent</Text>}
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
