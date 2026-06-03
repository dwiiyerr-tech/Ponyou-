# ponyou-tui

A polished terminal UI for the Ponyou Solana memecoin AI agent. TypeScript + Ink + React. Runs on a VPS and on Termux (Android), Node 18+.

```
┌ ponyou · memecoin agent ───────────────────── ● live · demo ─┐
│ 1 Dashboard  2 Watchlist  3 Logs  4 PnL  5 Setup  6 Doctor    │
└──────────────────────────────────────────────────────────────┘
```

## Install & run

```bash
cd terminal-ui
pnpm install          # or: npm install
pnpm build            # compile TS → dist/
pnpm start            # run the dashboard
# dev (no build step):
pnpm dev
```

On Termux: `pkg install nodejs`, then the same commands. The layout collapses to a single column and drops secondary table columns below 72 cols.

## Screens

| Key | Screen | What it shows |
| --- | --- | --- |
| `1` | Dashboard | agent status, wallet + SOL balance, active strategy, risk mode, automation |
| `2` | Watchlist | token ticker, liquidity, volume, age, risk score, conviction |
| `3` | Logs | streaming agent logs with severity colours |
| `4` | PnL | realized / unrealized P&L, win rate, open positions |
| `5` | Setup | wizard: GMGN API key, RPC URL, wallet pubkey, risk limits |
| `6` | Doctor | env, API keys, RPC health, network, Node version, bot process |

## Keys

- `1`–`6` — switch screens (instant, no animation)
- `/` — command palette (`/scan`, `/watch`, `/pnl`, `/logs`, `/strategy`, `/doctor`, `/setup`, `/quit`)
- `↑ ↓` — navigate lists / wizard steps
- `r` — re-run doctor checks
- `esc` — leave the wizard
- `q` — quit

## How it reads data

Pure file reads from the project root (`PONYOU_ROOT`, defaults to the parent dir):
`user-config.json`, `metrics.json`, `state.json` (or `demo/state.json` in paper mode),
`coin-conviction.json`, `closed-positions-archive.json`, and the supervisor log tail.
Commands are sent via the dashboard API (`POST /api/cmd`, port `PONYOU_DASHBOARD_PORT`)
with a `dashboard-cmd.json` file fallback. No bot code changes required.

## Design notes

Built on Emil Kowalski's design-engineering principles, adapted to terminals:
keyboard-initiated actions (screen switch, palette) never animate; the only motion
is async-wait spinners and streaming doctor checks. One accent colour (cyan),
semantic severity palette, consistent spacing, and explicit loading / empty / error /
success states everywhere.
