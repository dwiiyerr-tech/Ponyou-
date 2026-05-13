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
npm run dev   # Dry run (no real transactions)
npm start     # Live trading mode
```

## Commands

- `/status` - Wallet balance and open positions
- `/screen` - Refresh top token candidates
- `/close <n>` - Close a specific position
- `/stop` - Graceful shutdown

---

## Disclaimer

Memecoin trading is extremely risky. Ponyou is provided as-is. Use at your own risk.
