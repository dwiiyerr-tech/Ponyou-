# Ponyou AI Agent

**Autonomous AI trading agent for Solana memecoins, powered by LLMs.**

Ponyou is a memecoin-focused trading agent. It runs continuous screening and management cycles, identifying high-potential tokens and managing positions autonomously.

Upgraded with ideas from [Charon](https://github.com/yunus-0x/charon) — a Telegram trench agent for Pump.fun token screening.

---

## Features

- **Multi-Strategy System** — Switch between `sniper`, `dip_buy`, `smart_money`, and `degen` strategies, each with their own filters and ROI tables.
- **Multi-Source Signal Pipeline** — Combines GMGN discovery, trending tokens, and graduated pump.fun tokens as signal sources.
- **Pipeline LLM Pre-Screening** — Batch-screens up to 10 candidates in one LLM call (BUY/WATCH/PASS + confidence) before the agent loop.
- **Enhanced Candidate Filtering** — ATH distance gate, bundle rate check, rug ratio, source count validation per strategy.
- **Autonomous Memecoin Screening** — Scans for new and trending tokens with high organic engagement and smart money backing.
- **Position Management** — Monitors PnL and exits based on take-profit/stop-loss or trend changes.
- **Solana Integration** — Works with GMGN (swaps) and OKX (risk signals).
- **Rug Protection** — Integrated audit signals and blacklist management.
- **Interactive REPL** — Control the agent and chat via terminal or Telegram.

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
   # - OPENROUTER_API_KEY (or LLM_API_KEY)
   ```

3. **Configure Strategy**
   ```bash
   cp user-config.example.json user-config.json
   # Set activeStrategy: "sniper" | "dip_buy" | "smart_money" | "degen"
   # Enable signals: useTrending, useGraduated
   ```

## Running

```bash
npm run dev   # Dry run (no real transactions)
npm start     # Live trading mode
```

## Commands

### CLI
- `/strategy` — List strategies and current active strategy
- `/strategy <name>` — Switch to `sniper`, `dip_buy`, `smart_money`, or `degen`
- `/pilot check` — Show trading plan status
- `/auto on|off` — Enable/disable automation
- `/smart` — Scan smart money wallets
- `/off` — Graceful shutdown

### Telegram
- `/status` — Wallet balance, plan, and active strategy
- `/strategy` — Show strategies
- `/strategy <name>` — Hot-switch active strategy
- `/pnl` — Performance table

## Strategies (Charon-inspired)

| Strategy | Description | Risk | Best For |
|---|---|---|---|
| `sniper` | Fast entry on new tokens | High | HOT/EXTREME market |
| `dip_buy` | Buy dips >= 40% below ATH | Medium | Reversal setups |
| `smart_money` | Follow known smart wallets | Low-Med | Quality entries |
| `degen` | Aggressive high-risk entries | Very High | EXTREME market |

## Configuration (`user-config.json`)

```json
{
  "activeStrategy": "sniper",
  "useTrending": true,
  "useGraduated": false,
  "pipelineLlmEnabled": true,
  "pipelineLlmMinConfidence": 65
}
```

---

## Disclaimer

Memecoin trading is extremely risky. Ponyou is provided as-is. Use at your own risk.
