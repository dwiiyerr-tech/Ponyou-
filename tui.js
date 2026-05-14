/**
 * PONYOU TUI — Terminal User Interface
 *
 * Layout (mirrors Hermes Weather Agent style):
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                      PONYOU  vX.X                               │
 * ├─────────────────┬───────────────────────────┬───────────────────┤
 * │  Agent Info     │      Agent Log            │  Equity + Scan    │
 * │  Positions      │      (streaming)          │  (chart + table)  │
 * ├─────────────────┴───────────────────────────┴───────────────────┤
 * │  [ticker] SOL: X.XX  POS: N  PnL: +X.XX%  STRATEGY: sniper ... │
 * └─────────────────────────────────────────────────────────────────┘
 */

process.env.TUI_MODE = "1";

import blessed from "blessed";
import contrib from "blessed-contrib";
import { tuiEvents } from "./tui-events.js";
import { getStateSummary } from "./state.js";
import { getPerformanceHistory } from "./lessons.js";
import { getDemoStats } from "./demo/virtualWallet.js";
import { getActiveStrategyName } from "./strategy.js";
import { config } from "./config.js";
import { agentLoop } from "./agent.js";

// ─── Screen ───────────────────────────────────────────────────

const screen = blessed.screen({
  smartCSR: true,
  title: "PONYOU",
  fullUnicode: true,
  dockBorders: true,
});

// ─── Grid ─────────────────────────────────────────────────────

const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// ─── Title bar (row 0, full width) ────────────────────────────

const titleBar = grid.set(0, 0, 1, 12, blessed.box, {
  content: "",
  tags: true,
  style: { fg: "yellow", bg: "#1a1a1a", bold: true },
  border: { type: "line", fg: "#333" },
  padding: { left: 1 },
});

// ─── Left panel — Agent Info (rows 1-8, cols 0-2) ─────────────

const infoBox = grid.set(1, 0, 5, 3, blessed.box, {
  label: " {bold}{yellow-fg}◈ AGENT INFO{/yellow-fg}{/bold} ",
  tags: true,
  scrollable: false,
  style: { fg: "white", bg: "#0d0d0d", border: { fg: "#444" } },
  border: { type: "line" },
  padding: { left: 1, top: 0 },
});

// ─── Left panel — Open Positions (rows 6-10, cols 0-2) ────────

const posTable = grid.set(6, 0, 5, 3, contrib.table, {
  label: " {bold}{cyan-fg}◈ POSITIONS{/cyan-fg}{/bold} ",
  tags: true,
  keys: true,
  interactive: false,
  columnSpacing: 1,
  columnWidth: [9, 6, 7, 6],
  style: {
    fg: "white",
    bg: "#0d0d0d",
    border: { fg: "#444" },
    header: { fg: "cyan", bold: true },
    cell: { fg: "white", selected: { bg: "#333" } },
  },
  border: { type: "line" },
});

// ─── Middle panel — Agent Log (rows 1-10, cols 3-8) ───────────

const logBox = grid.set(1, 3, 10, 6, contrib.log, {
  label: " {bold}{green-fg}◈ AGENT LOG{/green-fg}{/bold} ",
  tags: true,
  scrollable: true,
  scrollOnInput: false,
  mouse: true,
  keys: true,
  vi: true,
  style: {
    fg: "#ccc",
    bg: "#080808",
    border: { fg: "#444" },
    scrollbar: { bg: "#333" },
  },
  border: { type: "line" },
  scrollbar: { ch: "│", style: { bg: "#333" } },
});

// ─── Right panel — Equity Chart (rows 1-5, cols 9-11) ─────────

const equityLine = grid.set(1, 9, 5, 3, contrib.line, {
  label: " {bold}{magenta-fg}◈ EQUITY{/magenta-fg}{/bold} ",
  tags: true,
  showLegend: false,
  wholeNumbersOnly: false,
  style: {
    bg: "#0d0d0d",
    border: { fg: "#444" },
    line: "yellow",
    text: "white",
    baseline: "#333",
  },
  border: { type: "line" },
  xLabelPadding: 2,
  xPadding: 4,
  numYLabels: 4,
});

// ─── Right panel — Candidate Scan (rows 6-10, cols 9-11) ──────

const scanTable = grid.set(6, 9, 5, 3, contrib.table, {
  label: " {bold}{blue-fg}◈ CANDIDATES{/blue-fg}{/bold} ",
  tags: true,
  keys: false,
  interactive: false,
  columnSpacing: 1,
  columnWidth: [9, 5, 5],
  style: {
    fg: "white",
    bg: "#0d0d0d",
    border: { fg: "#444" },
    header: { fg: "blue", bold: true },
    cell: { fg: "white" },
  },
  border: { type: "line" },
});

// ─── Bottom Ticker (row 11, full width) ───────────────────────

const ticker = grid.set(11, 0, 1, 12, blessed.box, {
  content: "",
  tags: true,
  style: { fg: "#aaa", bg: "#111", border: { fg: "#333" } },
  border: { type: "line" },
  padding: { left: 1 },
});

// ─── State ────────────────────────────────────────────────────

const state = {
  sol: 0,
  sol_usd: 0,
  free_sol: 0,
  mode: process.env.DEMO_MODE === "true" ? "DEMO"
      : process.env.DRY_RUN === "true" ? "DRY RUN"
      : "LIVE",
  strategy: "sniper",
  step: 0,
  maxSteps: config.llm?.maxSteps || 20,
  positions: [],
  candidates: [],
  equityHistory: [],
  totalPnl: 0,
  winRate: 0,
  totalTrades: 0,
  lastScan: null,
  logLines: 0,
};

// ─── Color Helpers ────────────────────────────────────────────

function pnlColor(val) {
  if (val > 0) return `{green-fg}+${val.toFixed(2)}%{/green-fg}`;
  if (val < 0) return `{red-fg}${val.toFixed(2)}%{/red-fg}`;
  return `{white-fg}0.00%{/white-fg}`;
}

function modeColor(m) {
  if (m === "LIVE")    return `{red-fg}● LIVE{/red-fg}`;
  if (m === "DEMO")    return `{cyan-fg}◎ DEMO{/cyan-fg}`;
  if (m === "DRY RUN") return `{yellow-fg}◌ DRY RUN{/yellow-fg}`;
  return m;
}

function categoryColor(cat) {
  const c = cat.toLowerCase();
  if (c.includes("error")) return "{red-fg}";
  if (c.includes("warn"))  return "{yellow-fg}";
  if (c.includes("trade") || c.includes("buy") || c.includes("sell")) return "{green-fg}";
  if (c.includes("tool"))  return "{blue-fg}";
  if (c.includes("agent")) return "{cyan-fg}";
  if (c.includes("demo"))  return "{magenta-fg}";
  return "{white-fg}";
}

const VERDICT_COLOR = { BUY: "{green-fg}", WATCH: "{yellow-fg}", PASS: "{red-fg}" };

// ─── Title Bar ────────────────────────────────────────────────

function renderTitle() {
  const ver = "v1.1.0";
  const now = new Date().toLocaleTimeString("id-ID", { hour12: false });
  const stepStr = `Step ${state.step}/${state.maxSteps}`;
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
  titleBar.setContent(
    ` {bold}{yellow-fg}◆ PONYOU ${ver}{/yellow-fg}{/bold}` +
    `  ${modeColor(state.mode)}` +
    `  {white-fg}Strategy: {cyan-fg}${state.strategy}{/cyan-fg}{/white-fg}` +
    `  {white-fg}${stepStr}{/white-fg}` +
    `  {#555-fg}${now}{/#555-fg}`
  );
}

// ─── Info Panel ───────────────────────────────────────────────

function renderInfo() {
  const lines = [];

  lines.push(`{yellow-fg}SOL Balance{/yellow-fg}`);
  lines.push(`  Total : {white-fg}${state.sol.toFixed(4)} SOL{/white-fg}`);
  lines.push(`  USD   : {white-fg}$${state.sol_usd.toFixed(2)}{/white-fg}`);
  lines.push(``);

  lines.push(`{yellow-fg}Trading{/yellow-fg}`);
  lines.push(`  Trades: {white-fg}${state.totalTrades}{/white-fg}`);
  lines.push(`  Win%  : {white-fg}${state.winRate}%{/white-fg}`);
  lines.push(`  PnL   : ${pnlColor(state.totalPnl)}`);
  lines.push(``);

  lines.push(`{yellow-fg}Status{/yellow-fg}`);
  lines.push(`  Mode  : ${modeColor(state.mode)}`);
  lines.push(`  Strat : {cyan-fg}${state.strategy}{/cyan-fg}`);
  lines.push(`  Scan  : {#555-fg}${state.lastScan || "—"}{/#555-fg}`);
  lines.push(`  Pos   : {white-fg}${state.positions.length} open{/white-fg}`);

  if (state.mode === "DEMO") {
    try {
      const ds = getDemoStats();
      if (ds.initialized) {
        lines.push(``);
        lines.push(`{cyan-fg}Demo Stats{/cyan-fg}`);
        lines.push(`  SOL   : {white-fg}${ds.sol_balance.toFixed(4)}{/white-fg}`);
        lines.push(`  Wins  : {green-fg}${ds.win_count}{/green-fg} / {red-fg}${ds.loss_count}{/red-fg} loss`);
      }
    } catch (_) {}
  }

  infoBox.setContent(lines.join("\n"));
}

// ─── Positions Table ──────────────────────────────────────────

function renderPositions() {
  const headers = ["Token", "SOL", "PnL%", "Age"];
  const rows = state.positions.length > 0
    ? state.positions.map(p => {
        const ageMin = p.deployed_at
          ? Math.floor((Date.now() - new Date(p.deployed_at).getTime()) / 60000)
          : 0;
        const pnl = p.pnl_pct ?? 0;
        const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(1) + "%";
        const mint = p.pool?.slice(0, 8) || p.position?.slice(0, 8) || "—";
        const sol = (p.amount_sol ?? 0).toFixed(3);
        return [mint, sol, pnlStr, `${ageMin}m`];
      })
    : [["—", "—", "—", "—"]];

  posTable.setData({ headers, data: rows });
}

// ─── Candidates Table ─────────────────────────────────────────

function renderCandidates() {
  const headers = ["Token", "MC", "Verd"];
  const rows = state.candidates.length > 0
    ? state.candidates.slice(-8).map(c => {
        const sym = (c.symbol || c.mint?.slice(0, 8) || "?").slice(0, 8);
        const mc = c.usd_market_cap
          ? `$${(c.usd_market_cap / 1000).toFixed(0)}K`
          : "—";
        const v = c._verdict || "—";
        return [sym, mc, v];
      })
    : [["—", "—", "—"]];

  scanTable.setData({ headers, data: rows });
}

// ─── Equity Chart ─────────────────────────────────────────────

function renderEquity() {
  const hist = state.equityHistory;
  if (hist.length < 2) {
    equityLine.setData([{
      title: "equity",
      x: ["0"],
      y: [0],
      style: { line: "yellow" },
    }]);
    return;
  }

  const labels = hist.map((_, i) => i % 5 === 0 ? `T-${hist.length - i}` : "");
  equityLine.setData([{
    title: "equity",
    x: labels,
    y: hist,
    style: { line: "yellow" },
  }]);
}

// ─── Ticker Bar ───────────────────────────────────────────────

function renderTicker() {
  const parts = [];

  parts.push(`{yellow-fg}◆ PONYOU{/yellow-fg}`);
  parts.push(`SOL: {white-fg}${state.sol.toFixed(3)}{/white-fg}`);
  parts.push(`POS: {cyan-fg}${state.positions.length}{/cyan-fg}`);
  parts.push(`WIN: {green-fg}${state.winRate}%{/green-fg}`);
  parts.push(`PnL: ${pnlColor(state.totalPnl)}`);
  parts.push(`MODE: ${modeColor(state.mode)}`);
  parts.push(`STRAT: {cyan-fg}${state.strategy}{/cyan-fg}`);

  if (state.positions.length > 0) {
    parts.push(`{#555-fg}|{/#555-fg}`);
    for (const p of state.positions.slice(0, 4)) {
      const sym = p.pool?.slice(0, 6) || p.position?.slice(0, 6) || "?";
      const pnl = p.pnl_pct ?? 0;
      parts.push(`${sym} ${pnlColor(pnl)}`);
    }
  }

  ticker.setContent("  " + parts.join("  {#555-fg}·{/#555-fg}  "));
}

// ─── Full Render ──────────────────────────────────────────────

function render() {
  renderTitle();
  renderInfo();
  renderPositions();
  renderEquity();
  renderCandidates();
  renderTicker();
  screen.render();
}

// ─── Log Formatting ───────────────────────────────────────────

const LOG_CATEGORY_ICON = {
  agent:    "◈",
  tool:     "⚙",
  trade:    "💱",
  buy:      "↑",
  sell:     "↓",
  error:    "✗",
  warn:     "⚠",
  startup:  "▶",
  demo:     "◎",
  screen:   "🔍",
  learning: "✦",
  manager:  "★",
};

function formatLogLine(category, message) {
  const ts = new Date().toLocaleTimeString("id-ID", { hour12: false });
  const icon = LOG_CATEGORY_ICON[category.toLowerCase()] || "›";
  const col = categoryColor(category);
  const cat = category.toUpperCase().padEnd(8).slice(0, 8);
  // Truncate long messages to fit panel
  const msg = message.length > 120 ? message.slice(0, 117) + "…" : message;
  return `{#555-fg}${ts}{/#555-fg} ${col}${icon} ${cat}{/${col.slice(1)}} ${msg}`;
}

// ─── Event Handlers ───────────────────────────────────────────

tuiEvents.on("log", ({ category, message }) => {
  logBox.log(formatLogLine(category, message));
  state.logLines++;

  // Update last scan time on screening events
  if (category.toLowerCase().includes("screen") || category.toLowerCase().includes("discover")) {
    state.lastScan = new Date().toLocaleTimeString("id-ID", { hour12: false });
  }

  renderTitle();
  renderTicker();
  screen.render();
});

tuiEvents.on("balance", (balance) => {
  state.sol     = balance.sol ?? state.sol;
  state.sol_usd = balance.sol_usd ?? state.sol_usd;
  state.free_sol = balance.free_sol ?? state.free_sol;

  // Track equity history (SOL + token values)
  const totalSol = balance.sol ?? 0;
  state.equityHistory.push(parseFloat(totalSol.toFixed(4)));
  if (state.equityHistory.length > 60) state.equityHistory.shift();

  render();
});

tuiEvents.on("positions", (positions) => {
  state.positions = Array.isArray(positions) ? positions : [];
  renderPositions();
  renderTicker();
  screen.render();
});

tuiEvents.on("trade", (data) => {
  if (data.pnl_pct !== undefined) {
    state.totalPnl = (state.totalPnl * state.totalTrades + data.pnl_pct) / (state.totalTrades + 1);
    state.totalTrades++;
    if (data.win) state.winRate = Math.round(
      ((state.winRate / 100 * (state.totalTrades - 1) + 1) / state.totalTrades) * 100
    );
    state.equityHistory.push(parseFloat((state.sol).toFixed(4)));
    if (state.equityHistory.length > 60) state.equityHistory.shift();
    renderEquity();
  }
  render();
});

tuiEvents.on("candidate", (token) => {
  // Avoid duplicates
  const existing = state.candidates.findIndex(c => c.mint === token.mint);
  if (existing >= 0) state.candidates[existing] = token;
  else state.candidates.push(token);
  if (state.candidates.length > 20) state.candidates.shift();
  renderCandidates();
  screen.render();
});

tuiEvents.on("step", ({ step, maxSteps }) => {
  state.step = step;
  state.maxSteps = maxSteps;
  renderTitle();
  screen.render();
});

// ─── Keyboard ─────────────────────────────────────────────────

screen.key(["q", "C-c"], () => {
  screen.destroy();
  process.exit(0);
});

screen.key(["C-l"], () => {
  logBox.setContent("");
  state.logLines = 0;
  screen.render();
});

// Tab cycles focus between panels
let focusIdx = 0;
const focusables = [logBox, posTable, scanTable];
screen.key(["tab"], () => {
  focusIdx = (focusIdx + 1) % focusables.length;
  focusables[focusIdx].focus();
  screen.render();
});

// ─── Periodic Refresh ─────────────────────────────────────────

// Refresh state from disk every 5 seconds
setInterval(() => {
  try {
    const summary = getStateSummary();
    state.positions = summary.positions || [];

    try {
      state.strategy = getActiveStrategyName();
    } catch (_) {}

    // Load equity from perf history
    try {
      const hist = getPerformanceHistory({ limit: 60 });
      if (hist.length > 1) {
        // Reconstruct equity curve from cumulative PnL
        let equity = state.sol;
        const curve = [];
        for (const t of hist) {
          equity = equity * (1 + (t.pnl_pct || 0) / 100);
          curve.push(parseFloat(equity.toFixed(4)));
        }
        if (curve.length > 0) state.equityHistory = curve;

        const wins = hist.filter(t => t.win);
        state.winRate = Math.round((wins.length / hist.length) * 100);
        state.totalTrades = hist.length;
        const avgPnl = hist.reduce((s, t) => s + (t.pnl_pct || 0), 0) / hist.length;
        state.totalPnl = parseFloat(avgPnl.toFixed(2));
      }
    } catch (_) {}
  } catch (_) {}

  render();
}, 5000);

// ─── Clock tick ───────────────────────────────────────────────

setInterval(() => {
  renderTitle();
  renderTicker();
  screen.render();
}, 1000);

// ─── Startup ──────────────────────────────────────────────────

// Load initial state from disk
try {
  const summary = getStateSummary();
  state.positions = summary.positions || [];
} catch (_) {}

try {
  state.strategy = getActiveStrategyName();
} catch (_) {}

// Initial render
render();

// Show startup message in log
logBox.log(formatLogLine("startup", "{yellow-fg}PONYOU TUI started{/yellow-fg} — Press {bold}q{/bold} to quit, {bold}Tab{/bold} to focus panel, {bold}Ctrl+L{/bold} to clear log"));
logBox.log(formatLogLine("startup", `Mode: ${state.mode}  Strategy: ${state.strategy}`));
screen.render();

// ─── Start Agent ──────────────────────────────────────────────

// Import index.js logic by running the main agent loop in TUI mode
// We dynamically import index.js which registers cronjobs & CLI
// but we suppress its console output via TUI_MODE=1

import("./index.js").catch(err => {
  logBox.log(formatLogLine("error", `Failed to start agent: ${err.message}`));
  screen.render();
});
