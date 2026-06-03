import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { color, glyph } from "../theme.js";

export interface PaletteCommand {
  cmd: string;       // e.g. "/scan"
  desc: string;
  run: () => void | Promise<void>;
}

interface PaletteProps {
  commands: PaletteCommand[];
  onClose: () => void;
}

/**
 * CommandPalette — Raycast-style command list with fuzzy filter.
 * Opened/closed by keyboard (used constantly) so there is NO open/close
 * animation, exactly like Raycast. Selection moves instantly. The only
 * "motion" is the cursor glyph repositioning — free, no perceived lag.
 */
export function CommandPalette({ commands, onClose }: PaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const filtered = commands.filter((c) =>
    `${c.cmd} ${c.desc}`.toLowerCase().includes(query.toLowerCase().replace(/^\//, "")),
  );
  const clampedIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIndex((i) => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.return) {
      const sel = filtered[clampedIndex];
      if (sel) { void sel.run(); onClose(); }
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.borderActive}
      paddingX={1}
    >
      <Box>
        <Text color={color.accent} bold>{glyph.arrowR} </Text>
        <TextInput value={query} onChange={(v) => { setQuery(v); setIndex(0); }} placeholder="type a command…" />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text color={color.faint}>{glyph.dot} no matching command</Text>
        ) : (
          filtered.slice(0, 8).map((c, i) => {
            const selected = i === clampedIndex;
            return (
              <Box key={c.cmd}>
                <Text color={color.accent}>{selected ? glyph.cursor : " "} </Text>
                <Box width={12}>
                  <Text color={selected ? color.accent : color.text} bold={selected}>{c.cmd}</Text>
                </Box>
                <Text color={color.faint}>{c.desc}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
