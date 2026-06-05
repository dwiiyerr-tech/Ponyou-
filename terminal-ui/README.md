# ponyou-tui

A polished terminal UI for the Ponyou Solana memecoin AI agent. TypeScript + Ink + React. Runs on a VPS and on Termux (Android), Node 18+.

```
◆ ponyou · memecoin agent                              ● live · demo
  1 Dashboard  2 Monitor  3 Watchlist  4 Logs  5 PnL  6 Setup  7 Doctor
```

The `ponyou` wordmark is a per-character truecolor gradient; everything else
lives in a single-accent (cyan) + semantic palette. See `DESIGN.md` for the
full design spec.

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
| `2` | Monitor | live cockpit: vitals (balance, today P&L sparkline, open, win-rate), open positions with mini P&L meters, live activity feed, chain-heat strip. `p` pauses the feed |
| `3` | Watchlist | token ticker, liquidity, volume, age, risk score, conviction |
| `4` | Logs | streaming agent logs with severity colours |
| `5` | PnL | realized / unrealized P&L, win rate, open positions |
| `6` | Setup | wizard: progress rail, inline validation, Review & Apply diff (GMGN key, RPC, wallet, risk limits) |
| `7` | Doctor | grouped diagnostics (Environment / API Keys / Network / Process) with remediation hints; `c` writes a report |

## Keys

- `1`–`7` — switch screens (instant, no animation)
- `/` — command palette (`/scan`, `/monitor`, `/watch`, `/pnl`, `/logs`, `/strategy`, `/doctor`, `/setup`, `/quit`)
- `↑ ↓` — navigate lists / wizard steps / monitor positions
- `p` — pause the monitor feed (freezes the live stream so you can read a row)
- `r` — re-run doctor checks · `c` — write a doctor report
- `esc` — leave the wizard
- `q` — quit

Tip: `PONYOU_TUI_SCREEN=monitor pnpm start` opens straight to a screen.

## How it reads data

Pure file reads from the project root (`PONYOU_ROOT`, defaults to the parent dir):
`user-config.json`, `metrics.json`, `state.json` (or `demo/state.json` in paper mode),
`coin-conviction.json`, `closed-positions-archive.json`, `market-chain-intel.json`
(chain heat), and the supervisor log tail.
Commands are sent via the dashboard API (`POST /api/cmd`, port `PONYOU_DASHBOARD_PORT`)
with a `dashboard-cmd.json` file fallback. No bot code changes required.

## Design notes

Built on Emil Kowalski's design-engineering principles, adapted to terminals
(full spec in `DESIGN.md`): keyboard-initiated actions (screen switch, palette)
never animate; motion is reserved for async-wait spinners, streaming doctor
checks, and the Monitor's `LIVE` pulse — which drops to a static `stale` dot the
moment the feed goes quiet, so motion always tells the truth. Exact truecolor
palette (one accent + semantic severity, downsamples cleanly on 16-colour
terminals), consistent spacing, and explicit loading / empty / error / success
states everywhere.
