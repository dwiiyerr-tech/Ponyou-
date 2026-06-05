import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.js";
import type { ScreenId } from "../types.js";

export const TABS: { id: ScreenId; label: string; key: string }[] = [
  { id: "dashboard", label: "Dashboard", key: "1" },
  { id: "monitor", label: "Monitor", key: "2" },
  { id: "watchlist", label: "Watchlist", key: "3" },
  { id: "logs", label: "Logs", key: "4" },
  { id: "pnl", label: "PnL", key: "5" },
  { id: "wizard", label: "Setup", key: "6" },
  { id: "doctor", label: "Doctor", key: "7" },
];

/**
 * TabBar — numbered screen tabs. Switching is keyboard-initiated and happens
 * dozens of times per session, so per Emil there is NO transition animation:
 * the active tab just changes instantly. The active state is shown by the
 * accent underline-style marker, not motion.
 */
export function TabBar({ active, compact }: { active: ScreenId; compact: boolean }) {
  return (
    <Box paddingX={1}>
      {TABS.map((t) => {
        const isActive = t.id === active;
        const label = compact ? t.label.slice(0, 4) : t.label;
        return (
          <Box key={t.id} marginRight={compact ? 1 : 2}>
            <Text color={isActive ? color.accent : color.dim} bold={isActive}>{t.key}</Text>
            <Text color={isActive ? color.accent : color.faint} bold={isActive}> {label}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
