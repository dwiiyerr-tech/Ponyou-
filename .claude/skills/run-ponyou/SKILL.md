---
name: run-ponyou
description: Launch, drive, screenshot, and command the Ponyou Solana memecoin trading bot. Use when asked to run, start, launch, screenshot, test, or send commands to the trading bot.
---

Ponyou is a Solana memecoin trading bot — cron-driven screening + management
cycles, Telegram bot, Dashboard IPC. 6 strategies, 7-layer rug defense,
30-day compound plan, staged DCA entry, smart wallet tracking.

The **driver** at `.claude/skills/run-ponyou/driver.mjs` is the single
entry point for an agent. No GUI — everything is JSON-over-files.

All paths below are relative to the repo root (`/home/ubuntu/ponyou`).

## Prerequisites

```bash
sudo apt-get install -y nodejs npm
npm install
```

Requires Node 18+ (tested on 22.x).

## Build

No compile step. Node.js ESM.

```bash
node --check index.js
```

## Run (agent path)

The driver talks via `dashboard-cmd.json` / `dashboard-response.json` IPC.
The running bot polls the command file every 3s, calls the in-process
handler, and writes a generic ack back.

**Important:** `cmd` is fire-and-forget. The IPC ack is always
`"(command executed)"` regardless of what the handler did — the
command's real output goes to Telegram (`sendHTML`), which the driver
cannot see. **To verify a command actually changed something, diff the
state before and after.**

### Launch (demo mode)

```bash
node .claude/skills/run-ponyou/driver.mjs launch demo
node .claude/skills/run-ponyou/driver.mjs wait-ready 15
```

### Verify the bot is alive

```bash
node .claude/skills/run-ponyou/driver.mjs is-running   # exit 0 = running
node .claude/skills/run-ponyou/driver.mjs status | head -20
```

### Send commands (fire-and-forget)

```bash
node .claude/skills/run-ponyou/driver.mjs cmd "/plan"
node .claude/skills/run-ponyou/driver.mjs cmd "/strategies"
node .claude/skills/run-ponyou/driver.mjs cmd "/strategy day_phase_trading"
node .claude/skills/run-ponyou/driver.mjs cmd "/health"
node .claude/skills/run-ponyou/driver.mjs cmd "/dayphase"
```

Every call returns `{response: "(command executed)", ts, id}`. That's an
ack the IPC was consumed, NOT the command's output.

### Verify a command had effect (screenshot diff)

```bash
# Read one field directly
node .claude/skills/run-ponyou/driver.mjs state active-strategy.id   # → "scalping"

# Or full screenshot diff
node .claude/skills/run-ponyou/driver.mjs screenshot /tmp/before.json
node .claude/skills/run-ponyou/driver.mjs cmd "/strategy day_phase_trading"
sleep 5
node .claude/skills/run-ponyou/driver.mjs screenshot /tmp/after.json
diff <(jq .'active-strategy' /tmp/before.json) <(jq .'active-strategy' /tmp/after.json)
```

`state <dot.path>` reads one field — handy for tight loops. Paths:
`active-strategy.id`, `trading-plan.days`, `state-summary._open_positions`,
`performance.win_rate`, `metrics._series_keys`, `running`. Returns `null`
+ exit 1 if the path doesn't exist.

### Screenshot (full state snapshot)

```bash
node .claude/skills/run-ponyou/driver.mjs screenshot /tmp/snap.json
cat /tmp/snap.json | head -40
```

Captures (≈7KB JSON): `active-strategy`, `trading-plan`, `performance`
(last 5 trades), `metrics`, `state-summary` (positions collapsed to
counts to keep the file small).

### Stop

```bash
node .claude/skills/run-ponyou/driver.mjs stop
```

Sends `/off`. Graceful shutdown via supervisor.

## Run (human path)

```bash
npm run dev    # demo mode with TTY REPL
npm start      # live mode (needs WALLET_PRIVATE_KEY)
```

The TTY shows an ASCII dashboard + readline prompt. **Useless headless** —
nothing prints, the readline prompt isn't connected, logs land in
`logs/supervisor/`.

## Direct invocation (test internal modules)

`node -e` runs as ESM because `package.json` has `"type": "module"` —
top-level `import` works inline. Useful for testing modules without
launching the bot.

```bash
# Strategy presets + staged entry configs
node -e "import { PRESETS } from './strategies.js'; Object.entries(PRESETS).forEach(([id,s]) => console.log(id, '| staged:', s.staged_entry?.enabled ? s.staged_entry.stages+'stage '+s.staged_entry.trigger_type : 'off', '| mcap:', s.filters?.min_mcap_usd||'-', '→', s.filters?.max_mcap_usd||'-'))"

# Rug scoring + anomaly detection
node -e "import { scoreRugRisk } from './lessons.js'; console.log(scoreRugRisk({mint:'test', rug_signals:{}}))"
node -e "import { detectAnomaly } from './tools/rug-anomaly.js'; console.log(detectAnomaly({top10_concentration_pct:90,supply_concentrated:true}))"

# Staged entry engine
node -e "import { getStage1Amount, initStagedEntry, checkStagedEntryTrigger } from './tools/staged-entry.js'; const t=checkStagedEntryTrigger(initStagedEntry(null,{staged_entry:{enabled:true,stages:3,stage_pct:[35,35,30],trigger_type:'price',price_trigger_pct:-5}},getStage1Amount({enabled:true,stages:3,stage_pct:[35,35,30]},0.5),0.10),-6,0.094,10); console.log('Trigger:', t.trigger, t.reason)"

# Tier execution (strategy-aware market cap tiers)
node -e "import { getTierExecutionProfile } from './strategy.js'; console.log('scalping 60M:', getTierExecutionProfile(60_000_000).sell_only); console.log('day_phase 60M:', getTierExecutionProfile(60_000_000,'day_phase_trading').sell_only)"

# Switch active strategy from a fresh process (writes active-strategy.json)
node -e "import { setActiveStrategy, getStrategy } from './strategies.js'; setActiveStrategy('day_phase_trading'); console.log('Active:', getStrategy().id)"

# Full app startup (10s smoke — initialises, prints CRON jobs, then dies)
EXECUTION_MODE=demo SCREENING_MODE=dexscreener timeout 10 node --disable-warning=DEP0040 index.js
```

## Test

```bash
npm test                 # vitest — 766 tests, 106 files, ~45s
npm run readiness        # operational readiness check
```

## Key features (for context)

- **6 strategies**: scalping, sniper, dip_buy, smart_money, degen, day_phase_trading
- **7-layer rug defense**: trash-filter → Token-2022 → Helius → patterns → anomaly → LLM → sell-sim
- **Staged DCA entry**: price-trigger (dip_buy 3-stage, smart_money 2-stage) + time-trigger (day_phase 2-day)
- **30-day compound plan**: auto-advance midnight UTC, crash recalibration, idempotent guard
- **Smart wallet tracking**: discovery → active → history → strategy (4-tier)
- **Strategy-aware exit params**: stoploss + trailing enforced per-strategy (not hardcoded)
- **Tier execution**: swing strategies allowed up to $200M FDV, scalping blocked at $50M

## Gotchas

- **`cmd` ack is a lie.** The response is *always* `"(command executed)"`,
  even for commands that took the wrong code path or no-op'd. The
  handler's real output goes to Telegram. **To know a command worked,
  diff the state.** See "Verify a command had effect" above.
- **The bot does not hot-reload.** It pins the JS modules at process
  start. If you edit `strategies.js`, `index.js`, etc. after launch,
  the running bot still runs the old code — IPC acks succeed but the
  effect is the old behavior. Restart after every source edit if you
  want IPC commands to reflect new logic.
- **Telegram output is invisible.** `/plan`, `/health`, `/strategies`,
  `/menu`, `/status` all produce rich text via `sendHTML()` that goes
  to Telegram only. The driver sees only the ack. Read the JSON state
  files instead.
- **Dashboard IPC polling is 3s.** Driver `cmd` waits 4s then reads
  the ack. If the bot is mid-cron it can be later — `cmd` will return
  `"(no response)"`. Retry.
- **`active-strategy.json` may rewrite itself.** Periodic state-sync
  re-touches the file even when nothing changed. Compare the `id`
  field, not the file mtime.
- **TTY only with `process.stdin.isTTY`.** Headless launches start
  silently; logs land in `logs/supervisor/`.
- **`.env` is permission-protected.** Use env vars on the command line
  instead: `EXECUTION_MODE=demo SCREENING_MODE=dexscreener`.
- **`WALLET_PRIVATE_KEY` required for live mode.** Demo mode runs
  without it.
- **Driver ROOT** = `.claude/skills/run-ponyou/` → `..` × 3 → repo
  root. Don't move `driver.mjs`.
- **PID files in `logs/supervisor/` can go stale.** Driver uses
  `ps aux | grep '[i]ndex.js'` instead.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `driver.mjs cmd` returns `(no response)` | Wait 6s and retry. IPC mid-cycle. |
| `cmd "/strategy <id>"` returns ack but `active-strategy.json` unchanged | Bot probably running stale code from a long-lived process. `stop`, then `launch demo` again. Confirm with `state active-strategy.id`. |
| `driver.mjs launch` hangs | Run `is-running` first. Already running? Use it. Stuck process? `pkill -f "node.*index.js"`. |
| `npm test` import errors | `npm install` first. Node 18+ required (tested on 22.x). |
| Screenshot ≤ 200 bytes | Bot not running. `launch demo` first. |
| `[DEP0040] punycode` warnings | Harmless. Already silenced via `--disable-warning=DEP0040` in the driver and in `package.json` scripts. |
| Full app startup logs say `HELIUS_*_URL not set — stream disabled` | Expected in demo without `.env`. The bot falls back to polling. Don't try to fix unless you're going live. |
