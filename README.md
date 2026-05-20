# Ponyou AI Agent 🐴

**Autonomous AI trading agent for Solana memecoins, powered by LLMs.**

Ponyou is a memecoin-focused trading agent. It runs continuous screening and management cycles, identifying high-potential tokens and managing positions autonomously.

---

## Features

- **Autonomous Memecoin Screening** — Scans for new and trending tokens with high organic engagement and smart money backing.
- **Position Management** — Monitors PnL and exits based on take-profit/stop-loss or trend changes.
- **Solana Integration** — Works with GMGN (swaps) and OKX (risk signals).
- **Rug Protection** — Integrated audit signals and blacklist management.
- **Interactive REPL** — Control the agent and chat via terminal or Telegram.
- **Multi-Strategy Presets (v4)** — Switch between `scalping`, `sniper`, `dip_buy`, `smart_money`, `degen` live via Telegram `/strategy <id>`. Each preset ships its own filter gates, ROI table, stop-loss, trailing & partial-TP rules.
- **Confirm Mode (v4)** — Optional human-in-the-loop: every BUY is parked as a pending intent and only executes after Telegram `/yes <id>`. Useful for live-trading supervision.
- **Partial Take-Profit (v4)** — Sell a fraction at TP1 and let the rest ride trailing — pre-configured on the `smart_money` preset.

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your:
   # - WALLET_PRIVATE_KEY
   # - RPC_URL
   # - OPENROUTER_API_KEY
   ```

3. **Configure Strategy**
   ```bash
   cp user-config.example.json user-config.json
   # Adjust thresholds and risk settings
   ```

## Running

```bash
./ponyou             # Open web dashboard like Hermes
./ponyou setup       # Open Hermes-style setup wizard
./ponyou web         # Web dashboard
./ponyou agent       # Live agent
./ponyou doctor live # Live readiness / doctor
```

You can also still use:

```bash
npm run dev   # Dry run (no real transactions)
npm start     # Live trading mode
```

## 24/7 Runtime

```bash
npm run agent:24x7        # Live mode with readiness check + auto-restart
npm run agent:24x7:demo   # Demo mode with readiness check + auto-restart
npm run web:24x7          # Dashboard web server with build + auto-restart
```

Supervisor logs go to `logs/supervisor/`.

For boot-time startup on Linux `systemd`, use the templates in `ops/ponyou-agent.service.example` and `ops/ponyou-dashboard.service.example`.

## Commands

### CLI / Telegram (general)
- `/status` — Wallet balance + plan summary
- `/pnl` — Recent trade history table
- `/screen` — Refresh top token candidates (CLI only)
- `/close <n>` — Close a specific position (CLI only)
- `/stop` — Graceful shutdown (CLI only)

### v4 — Strategy & Confirm-mode (Telegram)
- `/menu` — Snapshot: active strategy, plan, pending intents, confirm state
- `/strategy [id]` — Show or switch active strategy (hot, no restart)
- `/strategies` — List all 5 presets with their gates
- `/stratset <id> <key> <value>` — Override a single field of any preset (e.g. `/stratset sniper stoploss -0.20`)
- `/confirm on|off` — Toggle confirm mode at runtime
- `/agent on|off` — Power the supervised agent process on or off
- `/auto on|off` — Enable or disable the automation loop without killing the process
- `/pending` — List pending BUY intents waiting for approval
- `/yes <id>` / `/no <id>` — Approve / reject a pending intent

---

## Disclaimer

Memecoin trading is extremely risky. Ponyou is provided as-is. Use at your own risk.
