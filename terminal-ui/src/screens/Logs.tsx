import React from "react";
import { Box, Text } from "ink";
import { Panel } from "../components/Panel.js";
import { Empty } from "../components/StateViews.js";
import { useLogs } from "../hooks/useLogs.js";
import { colorForTag, color, glyph } from "../theme.js";
import type { TermSize } from "../hooks/useTerminalSize.js";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/**
 * Logs — streaming tail with severity colours. New lines append at the bottom
 * (natural reading order). No animation: logs arrive constantly, so motion
 * would be noise. The colour IS the signal — red errors jump out instantly.
 */
export function Logs({ size, active }: { size: TermSize; active: boolean }) {
  const { logs, loaded } = useLogs(300, 1000);
  const rows = Math.max(6, size.height - 9);
  const visible = logs.slice(-rows);
  const tagWidth = size.compact ? 6 : 8;

  return (
    <Panel title="Live Logs" hint={`tail ${glyph.dot} severity-coloured`} active={active}>
      {!loaded ? (
        <Empty message="Reading log stream…" />
      ) : visible.length === 0 ? (
        <Empty message="No log output found" hint="Is the bot running? Logs appear once it starts." />
      ) : (
        <Box flexDirection="column">
          {visible.map((l, i) => (
            <Box key={i}>
              {!size.compact && <Text color={color.faint}>{fmtTime(l.ts)} </Text>}
              <Box width={tagWidth}>
                <Text color={colorForTag(l.tag)} bold>{l.tag.slice(0, tagWidth - 1)}</Text>
              </Box>
              <Text color={color.text}>
                {l.text.slice(0, Math.max(10, size.width - tagWidth - (size.compact ? 4 : 12)))}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Panel>
  );
}
