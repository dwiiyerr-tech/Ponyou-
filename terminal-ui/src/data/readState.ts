/**
 * readState.ts — typed snapshot of the live bot state.
 *
 * Ported from terminal-app/src/data/state-bridge.js, narrowed to what the
 * TUI screens need. Pure file reads (no WS dependency) so it works headless
 * on a VPS or Termux. Every read fails soft to a sensible default.
 */
import { existsSync, statSync } from "node:fs";
import { rootPath, storePath, isPaperMode, readJson } from "./paths.js";
import type { AgentState, Position, WatchToken } from "../types.js";

interface RawConfig {
  agentName?: string;
  executionMode?: string;
  paperTrading?: boolean;
  strategy?: string;
  walletAddress?: string;
  maxPositions?: number;
  [k: string]: unknown;
}

export function readState(): AgentState {
  const config = readJson<RawConfig>(rootPath("user-config.json"), {});
  const paper = isPaperMode(config);

  const metrics = readJson<Record<string, any>>(rootPath("metrics.json"), {});
  const marketIntel = readJson<Record<string, any>>(rootPath("market-heatmap-state.json"), {});
  const fileState = readJson<Record<string, any>>(storePath("state.json", paper), {});
  const conviction = readJson<Record<string, any>>(storePath("coin-conviction.json", paper), {});
  const automation = readJson<Record<string, any>>(rootPath("automation-state.json"), {});
  const closed = readJson<any[]>(rootPath("closed-positions-archive.json"), []);

  // ── Open positions (state.js schema: key off `closed`, mint=`position`) ──
  const openPositionsList: Position[] = Object.entries(fileState.positions || {})
    .filter(([, v]: [string, any]) => v && !v.closed)
    .map(([k, v]: [string, any]) => {
      const rug = v.signal_snapshot?.rug_score ?? 0;
      return {
        sym: String(v.signal_snapshot?.symbol || v.pool_name || v.symbol || v.position || k).slice(0, 10),
        side: "BUY" as const,
        entry: Number(v.signal_snapshot?.entry_price || 0),
        pnlPct: Number(v.peak_pnl_pct || 0),
        size: Number(v.amount_sol || 0),
        risk: rug >= 70 ? "HIGH" : rug >= 40 ? "MED" : "LOW",
        age: v.deployed_at
          ? Math.round((Date.now() - new Date(v.deployed_at).getTime()) / 60000) + "m"
          : "--",
      } as Position;
    });

  // ── Watchlist — derived from the live conviction corpus ──
  const watchlist: WatchToken[] = Object.entries(conviction.coins || {})
    .map(([mint, c]: [string, any]) => {
      const rug = Number(c.rug_score ?? c.last_rug_score ?? 0);
      return {
        symbol: String(c.symbol || mint).slice(0, 10),
        mint,
        liquidity: Number(c.liquidity ?? c.last_liquidity ?? 0),
        volume: Number(c.volume ?? c.last_volume ?? 0),
        ageMin: c.first_seen
          ? Math.round((Date.now() - new Date(c.first_seen).getTime()) / 60000)
          : 0,
        riskScore: rug,
        score: Math.round(c.conviction_score ?? c.score ?? 0),
      } as WatchToken;
    })
    .sort((a, b) => b.score - a.score);

  // ── PnL ──
  const realized = closed.reduce((s, t: any) => {
    const usd = (t.entry_usd || 0) * ((t.pnl_pct ?? t.peak_pnl_pct ?? 0) / 100);
    return s + (Number.isFinite(usd) ? usd : 0);
  }, 0);
  const unrealized = openPositionsList.reduce((s, p) => {
    const entryUsd = p.size * (Number(fileState.sol_price) || marketIntel.solPrice || 0);
    return s + entryUsd * (p.pnlPct / 100);
  }, 0);

  const balanceSol = Number(fileState.balance_sol ?? config.walletBalance ?? 0);
  const solPrice = Number(fileState.sol_price ?? marketIntel.solPrice ?? 0);

  return {
    agentName: config.agentName || "ponyou-agent",
    mode: config.executionMode || (paper ? "demo" : "live"),
    paper,
    strategy: config.strategy || readJson<any>(rootPath("active-strategy.json"), {}).id || "scalping",
    network: "Solana",
    riskLevel: deriveRiskLevel(config, openPositionsList.length),
    balanceSol,
    solPrice,
    walletStatus: config.walletAddress ? "connected" : "disabled",
    rpcStatus: "FILE",
    connected: false,

    openPositions: openPositionsList.length,
    openPositionsList,
    winRate: Number(metrics.winRate ?? 0),
    dailyPnlUsd: Number(metrics.dailyPnl ?? 0),
    realizedPnlUsd: realized,
    unrealizedPnlUsd: unrealized,
    totalSwaps: Number(metrics.totalSwaps ?? 0),

    watchlist,
    automation: {
      active: automation.automationActive ?? false,
      qualified: automation.qualified ?? false,
      progressPct: automation.qualificationSummary?.progressPct ?? 0,
    },
    uptimeSec: process.uptime(),
    version: "1.0.0",
  };
}

function deriveRiskLevel(config: RawConfig, openCount: number): string {
  const max = Number(config.maxPositions ?? 3);
  if (max > 0 && openCount >= max) return "HIGH";
  if (openCount >= Math.ceil(max / 2)) return "MEDIUM";
  return "LOW";
}

/** Cheap liveness probe — is the bot process running? (best-effort) */
export function botRunning(): boolean {
  try {
    // The bot writes state.json frequently; treat a fresh mtime as "alive".
    const p = storePath("state.json", isPaperMode(readJson(rootPath("user-config.json"), {})));
    if (!existsSync(p)) return false;
    const ageMs = Date.now() - statSync(p).mtimeMs;
    return ageMs < 120_000; // touched within 2 min
  } catch {
    return false;
  }
}
