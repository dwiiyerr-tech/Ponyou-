# Ponyou Dashboard — Design Spec
**Date:** 2026-05-22  
**Status:** Approved  
**Scope:** Web dashboard (localhost) for remote control + setup wizard

---

## 1. Overview

A lightweight web dashboard served at `http://localhost:3000` that gives the operator:
- Real-time monitoring (positions, PnL, balance, live logs)
- Remote controls (start/stop, kill switch, strategy switch, feature toggles)
- Setup wizard (first-time config + per-feature guided setup)

The dashboard is a standalone process (`node dashboard.js`) that runs alongside the bot. It reads bot state from JSON files and sends commands via `automation-command.json` — the same file already consumed by `automation-control.js`. No direct process control; no shell injection surface.

---

## 2. Architecture

```
ponyou/
├── dashboard.js                 ← entrypoint
├── dashboard/
│   ├── server.js                ← Express + WebSocket server
│   ├── state-reader.js          ← reads state.json, vault-state.json, etc.
│   ├── command-writer.js        ← writes automation-command.json
│   ├── config-writer.js         ← writes user-config.json (wizard)
│   ├── routes/
│   │   ├── api.js               ← REST: /api/*
│   │   └── wizard.js            ← REST: /wizard/*
│   └── public/
│       ├── index.html           ← main dashboard
│       ├── wizard.html          ← setup wizard
│       ├── app.js               ← WebSocket client + UI logic
│       └── style.css            ← dark theme
```

**New dependencies (2):**
- `express@^4.19.0` — HTTP server + routing
- `ws@^8.18.0` — WebSocket server

**Security:** Server binds to `127.0.0.1` only. No auth needed (localhost only). Private key fields in config are masked (first 4 + last 4 chars) when read back via API.

---

## 3. Dashboard Screen (`/`)

Single-page layout, dark theme, auto-refresh via WebSocket.

```
┌─────────────────────────────────────────────────────┐
│  🟢 PONYOU RUNNING  │  2.45 SOL  │  +$12.40 today  │
├──────────────────────┬──────────────────────────────┤
│  OPEN POSITIONS      │  CONTROLS                    │
│                      │  [▶ Start] [⏹ Stop] [☠ Kill] │
│  TOKEN   PNL  HOLD   │                              │
│  BONK   +14%  4m     │  Strategy: [scalp       ▼]  │
│  WIF    -3%   12m    │                              │
│                      │  ○ Vault sweep    [ON ]      │
│                      │  ○ Trading plan   [OFF]      │
│                      │  ○ Daily guard    [ON ]      │
│                      │  ○ Learning mode  [OFF]      │
├──────────────────────┴──────────────────────────────┤
│  LIVE LOG                                           │
│  17:42:01 [screening] Found 3 candidates            │
│  17:42:05 [buy] BONK 0.05 SOL → tx: a1b2c3...      │
└─────────────────────────────────────────────────────┘
```

**Header:** bot status (running/stopped), balance SOL, PnL today USD  
**Left panel:** open positions table — token symbol, PnL%, hold time  
**Right panel:** start/stop/kill buttons + strategy dropdown + feature toggles  
**Bottom panel:** live log feed, last 50 lines, auto-scroll, color-coded by level

Dashboard has a second tab: **Commands** — maps all 20 bot slash commands to UI controls.

```
┌─────────────────────────────────────────────────────┐
│  [Dashboard]  [Commands]  [Settings ⚙]              │
├─────────────────────────────────────────────────────┤
│  🤖 BOT CONTROL                                     │
│  [▶ Auto ON] [⏹ Auto OFF]  [✅ Confirm ON/OFF]      │
│  [🧠 Agent ON] [🧠 Agent OFF]                       │
│                                                     │
│  📈 TRADING                                         │
│  [▶ Continue]  [⏹ Stop Trade]                       │
│  Pending intents: 2  [View /pending]                │
│  Intent #3: BUY WIF 0.05 SOL  [✅ Yes] [❌ No]     │
│                                                     │
│  🎯 STRATEGY                                        │
│  Active: scalp  [scalp ▼] [Set Strategy]           │
│  [List Strategies]                                  │
│                                                     │
│  🛡 GUARDS & PLANS                                  │
│  Daily Guard: OFF  [ON] [OFF]  Wins 2/3 · Loss 1/3 │
│  Trading Plan: 12/30  [Reset Plan]  [Plan Status]  │
│                                                     │
│  ☠ KILL SWITCH                                     │
│  [Kill Token: _________ ] [Kill]  [Unkill]         │
│  [Kill State]                                       │
│                                                     │
│  📊 INFO                                            │
│  [Metrics]  [Wallets]  [Menu]                       │
└─────────────────────────────────────────────────────┘
```

**Command mapping (20 commands):**

| Group | Command | Dashboard Control |
|-------|---------|-------------------|
| Bot Control | `/auto on\|off` | Toggle button |
| Bot Control | `/confirm on\|off` | Toggle button |
| Bot Control | `/agent on\|off` | Toggle button |
| Bot Control | `/menu` | Info button |
| Trading | `/continue` | Button |
| Trading | `/stoptrade` | Button |
| Trading | `/pending` | List with Yes/No per intent |
| Trading | `/yes <id>` | Inline button per pending intent |
| Trading | `/no <id>` | Inline button per pending intent |
| Strategy | `/strategies` | List display |
| Strategy | `/strategy <name>` | Dropdown + view |
| Strategy | `/stratset <name>` | Dropdown + set button |
| Guards | `/dailyguard on\|off` | Toggle + limit inputs |
| Guards | `/dailyguard limit N` | Number input |
| Guards | `/plan` | Status display |
| Guards | `/resetplan` | Button |
| Kill | `/kill <mint>` | Text input + button |
| Kill | `/unkill <mint>` | Text input + button |
| Kill | `/killstate` | Info button |
| Info | `/metrics` | Info button |
| Info | `/wallets` | Info button |

**Execution:** Each button → `POST /api/cmd` with `{ cmd: "/stoptrade" }` or `{ cmd: "/stratset", args: ["scalp"] }` → server calls internal `handleTelegramCommand(cmd + " " + args)` directly (same handler used by Telegram).

---

## 4. Setup Wizard (`/wizard`)

Multi-step form, 13 steps grouped by domain. Progress bar + Back/Next navigation. All fields pre-filled from existing `user-config.json` if present.

| Step | Group | Fields |
|------|-------|--------|
| 1/13 | **Wallet & RPC** | `walletAddress`, `privateKey` (masked), `rpcUrl`, `backupRpcUrl1`, `backupRpcUrl2` |
| 2/13 | **Telegram** | `telegramBotToken`, `telegramChatId`, [Send Test Message] button |
| 3/13 | **LLM / AI Model** | `llmProvider` (openrouter/custom), `llmModel`, `llmBaseUrl` (optional), API key env var reference |
| 4/13 | **Strategy & Trading Mode** | Strategy preset (scalp/conservative/aggressive), `confirmMode` toggle, `confirmTtlMin` |
| 5/13 | **Screening Filters** | `minMcap`, `maxMcap`, `minTvl`, `maxTvl`, `minVolume`, `minHolders`, `maxBundlePct`, `maxBotHoldersPct`, `maxTop10Pct` |
| 6/13 | **Position Management** | `deployAmountSol`, `gasReserve`, `positionSizePct`, `stopLossPct`, `takeProfitPct`, `autoTakeProfitPct`, `trailingTakeProfit` toggle, `trailingTriggerPct`, `trailingDropPct` |
| 7/13 | **Pilot / Daily Plan** | `pilotEnabled`, `pilotCapitalUsd`, `dailyTargetPct`, `dailyStopLossPct`, `planDays`, `maxConsecutiveLosses` |
| 8/13 | **Daily Trade Guard** | `dailyTradeGuard.enabled`, `maxWinsPerDay`, `maxLossesPerDay`, `learningModeDurationMin` |
| 9/13 | **Trading Plan 30** | `tradingPlan.enabled`, `tradingPlan.targetTrades`, `tradingPlan.resetOnNewSession` |
| 10/13 | **Vault / Savings** | `vault.sweep.enabled`, `vaultWallet`, `sweepPct`, `sweepIntervalDays`, `minSweepSol` |
| 11/13 | **Kelly & Risk** | `kelly.enabled`, `kellyFraction`, `kellyMinFraction`, `kellyMaxFraction`, `risk.maxPositions`, `risk.maxDeployAmount` |
| 12/13 | **Advanced Features** | `jito.enabled` + region + tipLamports, `fastTrack.enabled` + key thresholds, `multiWallet.enabled`, `strategy.evolution.enabled`, `darwin.enabled`, `schedule` intervals |
| 13/13 | **Review & Save** | Full preview of generated `user-config.json` (private key masked) → [💾 Save & Launch] |

**UX rules:**
- Steps 3–12 collapsible/skippable — operator can jump straight to Review with defaults
- Required fields (step 1–2) gated: cannot proceed to step 3 without walletAddress + telegramChatId
- Tooltip per field shows default value and short description
- [Reset to defaults] button on each step

**First-time detection:** If `user-config.json` does not exist or has no `walletAddress` → `GET /` redirects to `/wizard`. After wizard save → redirect to `/`.

**Re-entry:** Existing config pre-fills all fields. Operator can re-run wizard anytime via Settings link in dashboard header.

---

## 5. WebSocket Protocol

Server pushes to all connected clients every 2 seconds.

```js
// Message types (server → browser):
{ type: "state", data: {
    bot_running: boolean,
    balance_sol: number,
    pnl_today_usd: number,
    positions: [{ symbol, mint, pnl_pct, hold_minutes, entry_sol }],
    features: { vault_enabled, trading_plan_enabled, daily_guard_enabled, learning_mode_active },
    trading_plan: { enabled, trades_completed, target, remaining }
}}

{ type: "log",   data: { ts: string, level: string, message: string } }
{ type: "alert", data: { message: string } }  // sweep executed, kill triggered, etc.
```

Log streaming: dashboard tails a shared in-memory ring buffer (last 200 lines). Bot's `logger.js` writes to buffer; dashboard reads it on connect and subscribes to new entries.

---

## 6. REST API

```
GET  /api/status       → full state snapshot (same as WebSocket state event)
GET  /api/config       → user-config.json contents (private key masked)
POST /api/command      → { cmd: "start"|"stop"|"kill"|"unkill" }
POST /api/strategy     → { strategy: "scalp"|"conservative"|"aggressive" }
POST /api/toggle       → { feature: "vault"|"tradingPlan"|"dailyGuard", enabled: bool }
POST /api/resetplan    → resets trading plan session
POST /api/cmd          → { cmd: "/stoptrade"|"/continue"|"/kill"|..., args?: string[] }
GET  /wizard/config    → load existing config for pre-filling wizard
POST /wizard/save      → write user-config.json from wizard payload
```

**`POST /api/cmd` — universal command bridge:**
Calls `handleTelegramCommand(cmd + " " + args.join(" "))` directly — the same internal handler used by the Telegram bot. Returns `{ ok: true, response: "<text output>" }`. Response text is shown in a toast notification on dashboard. No `exec()`, no shell calls.

**`POST /api/command` (bot lifecycle):** writes to `automation-command.json`. Bot's existing `automation-control.js` polling loop picks it up on next cycle.

---

## 7. State Reading

`state-reader.js` reads these files on each poll cycle:

| File | Data |
|------|------|
| `state.json` | open positions, bot running state |
| `vault-state.json` | vault history, last sweep |
| `trading-plan-state.json` | session progress |
| `user-config.json` | active config (for feature toggle states) |
| `execution-quality.json` | win rate, recent trade quality |

All reads are try/catch — missing files return safe defaults.

---

## 8. How to Run

```bash
# start dashboard (default port 3000)
node dashboard.js

# custom port
node dashboard.js --port 4000

# open in browser
open http://localhost:3000
```

Add to `launch.sh`:
```bash
alias dash="node /home/ubuntu/ponyou/dashboard.js"
```

Optionally run as separate systemd service alongside `autowork.service`.

---

## 9. Out of Scope

- Authentication (localhost only)
- Mobile responsiveness (terminal operator use case)
- Historical charts / trade history graphs (future PR)
- Multi-wallet switching from dashboard (future PR)
