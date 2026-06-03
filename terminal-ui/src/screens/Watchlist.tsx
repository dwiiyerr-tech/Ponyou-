import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "../components/Panel.js";
import { Table, type Column } from "../components/Table.js";
import { Empty, Loading } from "../components/StateViews.js";
import { color, riskStyle, glyph } from "../theme.js";
import type { AgentState, WatchToken } from "../types.js";
import type { TermSize } from "../hooks/useTerminalSize.js";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
function fmtAge(min: number): string {
  if (min <= 0) return "—";
  if (min >= 1440) return `${Math.floor(min / 1440)}d`;
  if (min >= 60) return `${Math.floor(min / 60)}h`;
  return `${min}m`;
}

const columns: Column<WatchToken>[] = [
  { key: "sym", header: "TICKER", width: 10, render: (r) => `$${r.symbol}` },
  { key: "liq", header: "LIQ", width: 7, align: "right", render: (r) => `$${fmtNum(r.liquidity)}`, compactHide: false },
  { key: "vol", header: "VOL", width: 7, align: "right", render: (r) => `$${fmtNum(r.volume)}`, compactHide: true },
  { key: "age", header: "AGE", width: 5, align: "right", render: (r) => fmtAge(r.ageMin), compactHide: true },
  {
    key: "risk", header: "RISK", width: 6, align: "right",
    render: (r) => riskStyle(r.riskScore).label,
    color: (r) => riskStyle(r.riskScore).color,
  },
  { key: "conv", header: "CONV", width: 5, align: "right", render: (r) => String(r.score), color: (r) => (r.score >= 60 ? color.good : color.dim) },
];

export function Watchlist({ state, size, active }: { state: AgentState | null; size: TermSize; active: boolean }) {
  const [index, setIndex] = useState(0);
  const tokens = state?.watchlist ?? [];
  const maxRows = Math.max(5, size.height - 12);
  const visible = tokens.slice(0, maxRows);

  useInput((_i, key) => {
    if (!active) return;
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setIndex((i) => Math.min(visible.length - 1, i + 1));
  });

  if (!state) return <Loading label="Loading watchlist" />;

  return (
    <Panel
      title="Watchlist"
      hint={`${tokens.length} tokens ${glyph.dot} ↑↓ navigate`}
      active={active}
    >
      {visible.length === 0 ? (
        <Empty message="No tokens observed yet" hint="The hunter populates this as it scans. Try /scan." />
      ) : (
        <Table columns={columns} rows={visible} selectedIndex={Math.min(index, visible.length - 1)} compact={size.compact} />
      )}
      {tokens.length > maxRows && (
        <Box marginTop={1}>
          <Text color={color.faint}>  {glyph.dot} {tokens.length - maxRows} more below the fold</Text>
        </Box>
      )}
    </Panel>
  );
}
