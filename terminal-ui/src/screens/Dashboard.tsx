import React from "react";
import { Box, Text } from "ink";
import { Panel } from "../components/Panel.js";
import { KeyValue } from "../components/KeyValue.js";
import { Loading } from "../components/StateViews.js";
import { color, glyph } from "../theme.js";
import type { AgentState } from "../types.js";
import type { TermSize } from "../hooks/useTerminalSize.js";

function riskColor(level: string): string {
  if (level === "HIGH") return color.danger;
  if (level === "MEDIUM") return color.warn;
  return color.good;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function Dashboard({ state, size }: { state: AgentState | null; size: TermSize }) {
  if (!state) return <Loading label="Reading agent state" />;

  const wallet = [
    { label: "Balance", value: `${state.balanceSol.toFixed(4)} SOL`, bold: true },
    { label: "≈ USD", value: `$${(state.balanceSol * state.solPrice).toFixed(2)}`, color: color.dim },
    { label: "SOL price", value: state.solPrice > 0 ? `$${state.solPrice.toFixed(2)}` : "—", color: color.dim },
    { label: "Wallet", value: state.walletStatus, color: state.walletStatus === "connected" ? color.good : color.faint },
  ];

  const agent = [
    { label: "Strategy", value: state.strategy, color: color.accent, bold: true },
    { label: "Mode", value: state.mode, color: state.mode === "live" ? color.warn : color.text },
    { label: "Risk mode", value: state.riskLevel, color: riskColor(state.riskLevel), bold: true },
    { label: "Network", value: state.network, color: color.dim },
  ];

  const activity = [
    { label: "Open pos", value: String(state.openPositions), bold: true },
    { label: "Win rate", value: `${(state.winRate * 100).toFixed(0)}%`, color: state.winRate >= 0.5 ? color.good : color.dim },
    { label: "Today P&L", value: fmtUsd(state.dailyPnlUsd), color: state.dailyPnlUsd >= 0 ? color.good : color.danger },
    { label: "Swaps", value: String(state.totalSwaps), color: color.dim },
  ];

  const flexDir = size.compact ? "column" : "row";

  return (
    <Box flexDirection="column">
      <Box flexDirection={flexDir}>
        <Box flexGrow={1} marginRight={size.compact ? 0 : 1} marginBottom={size.compact ? 1 : 0}>
          <Panel title="Wallet"><KeyValue rows={wallet} /></Panel>
        </Box>
        <Box flexGrow={1}>
          <Panel title="Agent"><KeyValue rows={agent} /></Panel>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection={flexDir}>
        <Box flexGrow={1} marginRight={size.compact ? 0 : 1} marginBottom={size.compact ? 1 : 0}>
          <Panel title="Activity"><KeyValue rows={activity} /></Panel>
        </Box>
        <Box flexGrow={1}>
          <Panel title="Automation">
            <Box flexDirection="column">
              <Box>
                <Text color={state.automation.active ? color.good : color.faint}>
                  {state.automation.active ? glyph.live : glyph.idle}
                </Text>
                <Text color={color.text}> {state.automation.active ? "active" : "manual"}</Text>
              </Box>
              <Box marginTop={1}>
                <Text color={color.dim}>Qualified  </Text>
                <Text color={state.automation.qualified ? color.good : color.warn}>
                  {state.automation.qualified ? "yes" : `${state.automation.progressPct.toFixed(0)}%`}
                </Text>
              </Box>
              <Box>
                <Text color={color.dim}>Uptime     </Text>
                <Text color={color.dim}>{Math.floor(state.uptimeSec / 60)}m</Text>
              </Box>
            </Box>
          </Panel>
        </Box>
      </Box>
    </Box>
  );
}
