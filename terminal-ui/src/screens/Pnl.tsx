import React from "react";
import { Box, Text } from "ink";
import { Panel } from "../components/Panel.js";
import { KeyValue } from "../components/KeyValue.js";
import { Table, type Column } from "../components/Table.js";
import { Empty, Loading } from "../components/StateViews.js";
import { color, glyph } from "../theme.js";
import type { AgentState, Position } from "../types.js";
import type { TermSize } from "../hooks/useTerminalSize.js";

function fmtUsd(n: number): string {
  return `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
}
function pnlColor(n: number): string {
  return n > 0 ? color.good : n < 0 ? color.danger : color.dim;
}

const posColumns: Column<Position>[] = [
  { key: "sym", header: "TOKEN", width: 10, render: (r) => `$${r.sym}` },
  { key: "size", header: "SIZE", width: 8, align: "right", render: (r) => `${r.size.toFixed(3)}◎`, compactHide: true },
  { key: "pnl", header: "PNL%", width: 7, align: "right", render: (r) => `${r.pnlPct > 0 ? "+" : ""}${r.pnlPct.toFixed(1)}`, color: (r) => pnlColor(r.pnlPct) },
  { key: "age", header: "AGE", width: 5, align: "right", render: (r) => r.age, compactHide: true },
  { key: "risk", header: "RISK", width: 5, align: "right", render: (r) => r.risk, color: (r) => (r.risk === "HIGH" ? color.danger : r.risk === "MED" ? color.warn : color.good) },
];

export function Pnl({ state, size, active }: { state: AgentState | null; size: TermSize; active: boolean }) {
  if (!state) return <Loading label="Calculating P&L" />;

  const total = state.realizedPnlUsd + state.unrealizedPnlUsd;
  const summary = [
    { label: "Realized", value: fmtUsd(state.realizedPnlUsd), color: pnlColor(state.realizedPnlUsd), bold: true },
    { label: "Unrealized", value: fmtUsd(state.unrealizedPnlUsd), color: pnlColor(state.unrealizedPnlUsd), bold: true },
    { label: "Total", value: fmtUsd(total), color: pnlColor(total), bold: true },
    { label: "Win rate", value: `${(state.winRate * 100).toFixed(0)}%`, color: state.winRate >= 0.5 ? color.good : color.dim },
    { label: "Open / swaps", value: `${state.openPositions} / ${state.totalSwaps}`, color: color.dim },
  ];

  const flexDir = size.compact ? "column" : "row";

  return (
    <Box flexDirection="column">
      <Box flexDirection={flexDir}>
        <Box flexGrow={1} marginRight={size.compact ? 0 : 1} marginBottom={size.compact ? 1 : 0}>
          <Panel title="P&L Summary"><KeyValue rows={summary} labelWidth={13} /></Panel>
        </Box>
        <Box flexGrow={2}>
          <Panel title="Open Positions" hint={`${state.openPositions} open`} active={active}>
            {state.openPositionsList.length === 0 ? (
              <Empty message="No open positions" hint="Positions appear here once the agent buys." />
            ) : (
              <Table columns={posColumns} rows={state.openPositionsList} compact={size.compact} />
            )}
          </Panel>
        </Box>
      </Box>
      <Box marginTop={1} paddingX={1}>
        <Text color={color.faint}>
          {glyph.dot} Realized from closed trades {glyph.dot} unrealized marks open positions to current price
        </Text>
      </Box>
    </Box>
  );
}
