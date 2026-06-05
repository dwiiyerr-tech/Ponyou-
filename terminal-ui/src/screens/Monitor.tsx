import React, { useState, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { Vital } from "../components/Vitals.js";
import { Sparkline } from "../components/Sparkline.js";
import { MeterBar } from "../components/MeterBar.js";
import { Rule } from "../components/Rule.js";
import { Pulse } from "../components/Pulse.js";
import { Loading, Empty } from "../components/StateViews.js";
import { useLogs } from "../hooks/useLogs.js";
import { useInterval } from "../hooks/useInterval.js";
import { color, glyph, colorForTag } from "../theme.js";
import type { AgentState, Position, ChainHeat } from "../types.js";
import type { TermSize } from "../hooks/useTerminalSize.js";

// ── formatting ──────────────────────────────────────────────────────────────
function fmtUsd(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function fmtPrice(n: number): string {
  if (!n) return "—";
  if (n < 0.001) return `$${n.toFixed(7)}`;
  if (n < 1) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(3)}`;
}
function pnlColor(n: number): string {
  return n > 0 ? color.good : n < 0 ? color.danger : color.dim;
}
function pad(s: string, w: number, right = false): string {
  if (w <= 1) return "…";
  const c = s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s;
  return right ? c.padStart(w) : c.padEnd(w);
}
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function conditionColor(cond: string): string {
  const c = cond.toUpperCase();
  if (c === "EXTREME" || c === "HOT") return color.good;
  if (c === "NORMAL") return color.info;
  if (c === "COLD") return color.warn;
  return color.faint; // DEAD
}

const FRESH_MS = 10_000;

/**
 * Monitor — the leave-it-running cockpit. Dense and live, distinct from the
 * calm Dashboard. Vitals on top, a positions / activity split in the middle,
 * a chain-heat strip on the bottom. The LIVE pulse is the one ambient motion;
 * it drops to a static "stale" dot the moment the feed goes quiet, so motion
 * always tells the truth. `p` pauses the feed so you can read a row in peace.
 */
export function Monitor({ state, size, active }: { state: AgentState | null; size: TermSize; active: boolean }) {
  const { logs } = useLogs(80, 1000);
  const [paused, setPaused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [pnlSeries, setPnlSeries] = useState<number[]>([]);

  // Sample today's P&L on a steady cadence so the sparkline is real observed
  // data (the trajectory seen during this monitor session), never fabricated.
  const latest = useRef(0);
  latest.current = state?.dailyPnlUsd ?? 0;
  useInterval(() => {
    if (paused) return;
    setPnlSeries((s) => [...s, latest.current].slice(-40));
  }, 2000);

  useInput((input, key) => {
    if (!active) return;
    if (input === "p") { setPaused((p) => !p); return; }
    if (key.upArrow) setCursor((i) => Math.max(0, i - 1));
    if (key.downArrow) setCursor((i) => i + 1); // clamped below at selIdx
  });

  if (!state) return <Loading label="Connecting to agent" />;

  // Freshness honesty.
  const hasFeed = state.stateMtimeMs > 0;
  const ageMs = hasFeed ? Date.now() - state.stateMtimeMs : Infinity;
  const fresh = hasFeed && ageMs < FRESH_MS;
  const ageStr = fmtAge(ageMs);

  const statusNode = paused ? (
    <Text color={color.warn}>{glyph.idle} paused</Text>
  ) : !hasFeed ? (
    <Text color={color.faint}>{glyph.idle} file mode</Text>
  ) : fresh ? (
    <Text><Pulse on={!paused} color={color.good} /> <Text color={color.good}>LIVE</Text> <Text color={color.faint}>{glyph.dot} {ageStr} ago</Text></Text>
  ) : (
    <Text color={color.warn}>{glyph.idle} stale {glyph.dot} {ageStr} ago</Text>
  );

  // Positions ranked by attention (largest |P&L| floats up).
  const positions = [...(state.openPositionsList ?? [])].sort((a, b) => Math.abs(b.pnlPct ?? 0) - Math.abs(a.pnlPct ?? 0));
  const selIdx = positions.length ? Math.min(cursor, positions.length - 1) : -1;

  // Content width: terminal − app body padding (2) − this panel's border (2) − padding (2).
  const innerW = Math.max(24, size.width - 6);
  const twoCol = !size.compact && size.width >= 88;
  const gutter = 2;
  const leftW = twoCol ? Math.floor((innerW - gutter) * 0.56) : innerW;
  const rightW = twoCol ? innerW - gutter - leftW : innerW;

  const posRows = Math.max(3, Math.min(positions.length, size.height - 16));
  const feedRows = twoCol ? posRows + 2 : Math.max(4, Math.floor((size.height - 18) / 2));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? color.borderActive : color.border}
      paddingX={1}
    >
      {/* Title row with live status */}
      <Box justifyContent="space-between">
        <Text bold color={active ? color.accent : color.dim}>MONITOR</Text>
        {statusNode}
      </Box>

      {/* Vitals strip */}
      <Box marginTop={1} flexDirection={size.compact ? "column" : "row"} flexWrap="wrap">
        <Vital
          label="BALANCE"
          value={`${state.balanceSol.toFixed(3)} ◎`}
          sub={<Text color={color.dim}>≈ ${state.walletUsd.toFixed(0)}</Text>}
        />
        <Vital
          label="TODAY P&L"
          value={fmtUsd(state.dailyPnlUsd)}
          valueColor={pnlColor(state.dailyPnlUsd)}
          sub={
            pnlSeries.length > 1
              ? <Sparkline values={pnlSeries} width={10} color={pnlColor(state.dailyPnlUsd)} />
              : <Text color={color.faint}>sampling…</Text>
          }
          width={20}
        />
        <Vital
          label="OPEN"
          value={`${state.openPositions} / ${maxPositions(state)}`}
          sub={<Text color={color.faint}>{state.totalSwaps} swaps</Text>}
          width={14}
        />
        <Vital
          label="WIN RATE"
          value={`${(state.winRate * 100).toFixed(0)}%`}
          valueColor={state.winRate >= 0.5 ? color.good : color.dim}
          sub={<MeterBar value={state.winRate} max={1} width={10} color={state.winRate >= 0.5 ? color.good : color.warn} />}
        />
      </Box>

      {/* Body: positions | activity */}
      <Box marginTop={1} flexDirection={twoCol ? "row" : "column"}>
        <Box flexDirection="column" width={twoCol ? leftW : undefined} marginRight={twoCol ? gutter : 0}>
          <Rule width={leftW} label="OPEN POSITIONS" />
          <PositionsList rows={positions.slice(0, posRows)} selIdx={selIdx} width={leftW} compact={!twoCol && size.compact} />
          {positions.length > 0 && (
            <Box marginTop={1}>
              <Text color={color.faint}>
                realized <Text color={pnlColor(state.realizedPnlUsd)}>{fmtUsd(state.realizedPnlUsd)}</Text>
                {"  "}{glyph.dot} unreal <Text color={pnlColor(state.unrealizedPnlUsd)}>{fmtUsd(state.unrealizedPnlUsd)}</Text>
              </Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column" width={twoCol ? rightW : undefined} marginTop={twoCol ? 0 : 1}>
          <Rule width={rightW} label="ACTIVITY" />
          <ActivityFeed logs={logs} rows={feedRows} width={rightW} paused={paused} />
        </Box>
      </Box>

      {/* Chain heat */}
      <Box marginTop={1} flexDirection="column">
        <Rule width={innerW} label="CHAIN HEAT" />
        <ChainHeatStrip chains={state.chains} compact={size.compact} />
      </Box>
    </Box>
  );
}

function maxPositions(state: AgentState): string {
  // B5: always show the config limit (e.g. 5), not the current count.
  // Previous logic showed "4/4" at HIGH risk making it look capped at 4
  // when the real limit was 5. Use maxPositions from state (from config).
  return String(state.maxPositions ?? 3);
}

// ── Positions ─────────────────────────────────────────────────────────────
function PositionsList({ rows, selIdx, width, compact }: { rows: Position[]; selIdx: number; width: number; compact: boolean }) {
  if (rows.length === 0) {
    return <Box marginTop={1}><Empty message="No open positions" hint="scanning — positions appear on entry" /></Box>;
  }
  const symW = 8, pnlW = 7, meterW = 4;
  return (
    <Box flexDirection="column">
      {/* header */}
      <Box>
        <Text color={color.faint} wrap="truncate">{" "}{pad("SYM", symW)} {pad("ENTRY", 9, true)} {pad("P&L", pnlW, true)} {pad("", meterW)} {compact ? "" : pad("SIZE", 5, true) + " " + pad("AGE", 4, true)}</Text>
      </Box>
      {rows.map((p, i) => {
        const sel = i === selIdx;
        const arrow = p.pnlPct > 0 ? glyph.gain : p.pnlPct < 0 ? glyph.loss : glyph.flat;
        return (
          <Box key={i}>
            <Text color={color.accent}>{sel ? glyph.cursor : " "}</Text>
            <Text color={sel ? color.text : color.dim} bold={sel}>{pad(`$${p.sym}`, symW)} </Text>
            <Text color={color.dim}>{pad(fmtPrice(p.entry), 9, true)} </Text>
            <Text color={pnlColor(p.pnlPct)}>{pad(`${p.pnlPct > 0 ? "+" : ""}${p.pnlPct.toFixed(0)}%${arrow}`, pnlW, true)} </Text>
            <MeterBar value={Math.abs(p.pnlPct)} max={50} width={meterW} color={pnlColor(p.pnlPct)} />
            {!compact && (
              <Text color={color.faint}> {pad(`${p.size.toFixed(2)}◎`, 5, true)} {pad(p.age, 4, true)}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

// ── Activity feed ────────────────────────────────────────────────────────────
function ActivityFeed({ logs, rows, width, paused }: { logs: { ts: number; tag: string; text: string }[]; rows: number; width: number; paused: boolean }) {
  if (logs.length === 0) {
    return <Box marginTop={1}><Empty message="No activity yet" hint="events stream here once the bot runs" /></Box>;
  }
  // newest first; freeze the slice while paused so a row can be read in peace.
  const recent = [...logs].reverse().slice(0, rows);
  const tagW = 7;
  const textW = Math.max(8, width - tagW - 12);
  return (
    <Box flexDirection="column">
      {recent.map((l, i) => (
        <Box key={i}>
          <Text color={i === 0 && !paused ? color.accent : color.faint}>{i === 0 ? glyph.cursor : " "} </Text>
          <Text color={color.faint}>{fmtTime(l.ts)} </Text>
          <Text color={colorForTag(l.tag)} bold>{pad(l.tag, tagW)}</Text>
          <Text color={i === 0 ? color.text : color.dim} wrap="truncate"> {l.text.slice(0, textW)}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ── Chain heat strip ──────────────────────────────────────────────────────────
function ChainHeatStrip({ chains, compact }: { chains: ChainHeat[]; compact: boolean }) {
  if (!chains || chains.length === 0) {
    return <Box marginTop={1}><Empty message="No chain data yet" hint="the hunter fills this per screening cycle" /></Box>;
  }
  return (
    <Box flexWrap="wrap">
      {chains.map((c) => (
        <Box key={c.chain} marginRight={2}>
          <Text color={color.dim}>{c.chain.toUpperCase().padEnd(4)} </Text>
          <MeterBar value={c.score} max={100} width={compact ? 4 : 6} color={conditionColor(c.condition)} />
          <Text color={conditionColor(c.condition)}> {c.condition.toLowerCase()}</Text>
        </Box>
      ))}
    </Box>
  );
}
