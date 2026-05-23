# Ponyou TUI

Terminal dashboard for the Ponyou Solana memecoin trading agent. Four-panel
Textual app — agent identity + open positions on the left, live agent log in
the center, market intelligence + observed tokens + lessons on the right, and
a scrolling status ticker along the bottom.

## Install

```bash
cd tools/tui
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Requires Python 3.10+.

## Run

From the repository root:

```bash
python -m tools.tui.app
```

The TUI auto-discovers state files relative to the repo root — no extra
configuration needed if you launch it from there.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q` | Quit |
| `r` | Force a snapshot refresh |
| `l` | Pause / resume the live log |
| `f` | Toggle fullscreen log (hide side panels) |
| `h` | Show inline help notification |

## Data Sources

The TUI is **read-only**. It polls existing artifacts written by the agent:

| File | Used for |
|------|----------|
| `state.json` | Open positions, recent events |
| `metrics.json` | Session uptime, scan/manage latencies |
| `data/market-intel.json` | Market condition, confidence, buy ratio |
| `data/observed-tokens.json` | Scanner candidates panel |
| `data/lessons.json` | Trading lessons summary |
| `data/smart-wallets.json` | (reserved for future panels) |
| `logs/actions-YYYY-MM-DD.jsonl` | Live agent log feed (tailed) |

Snapshot polling runs every 2s; log tail polls every 0.5s and rotates on
date change. Missing or malformed files are surfaced as `WARN` lines in the
log panel rather than crashing the UI.

## Color Legend

| Color | Meaning |
|-------|---------|
| Gold `#FFD700` | Borders, titles, accent values |
| Green `#00FF41` | OK / LONG / passing filter |
| Orange `#FF8C00` | WARN / SHORT |
| Red `#FF3333` | ERR / failed filter / negative PnL |
| Cyan `#00FFFF` | API / RPC / tool calls, addresses |
| Gray `#888888` | Timestamps, muted metadata, thinking lines |

## Layout

```
┌─ ◆ PONYOU AGENT ─────────────────────────────────── session · uptime · mode ─┐
│┌─ AGENT ──────────┐┌─ AGENT LOG ────────────┐┌─ MARKET ─────────────────────┐│
││ identity         ││ HH:MM:SS [TAG] line     ││ condition / confidence / …  ││
│├─ ACTIVE POS. ────┤│ …                       │├─ OBSERVED TOKENS ───────────┤│
││ Pool Side SOL …  ││                         ││ Symbol MCap Age Filter      ││
│├─ RECENT EVENTS ──┤│                         │├─ LESSONS ────────────────────┤│
││ ts  line         ││                         ││ role · rule · score          ││
│└──────────────────┘└─────────────────────────┘└──────────────────────────────┘│
│●  ticker chips scrolling left ●  ●  …                                         │
│q quit · r refresh · l pause-log · h help · f fullscreen-log                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

## File Structure

```
tools/tui/
├── README.md
├── requirements.txt
├── app.py            # Textual App, workers, key bindings
├── app.tcss          # color scheme + layout
├── paths.py          # repo paths + polling intervals
├── data/
│   ├── state_reader.py   # async JSON snapshot aggregation
│   ├── log_tailer.py     # async log-file tail w/ rotation
│   └── formatters.py     # pure functions feeding panels
└── panels/
    ├── header.py
    ├── left_panel.py     # agent info + positions + recent events
    ├── agent_log.py      # center log w/ pause + tag colors
    ├── right_panel.py    # market + observed + lessons
    └── ticker.py         # bottom marquee
```

All I/O lives in `data/`. Widgets stay declarative.
