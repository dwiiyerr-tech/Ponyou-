# Ponyou AI Agent

Autonomous AI agent for automated memecoin trading on Solana.

## Project Focus

- **Memecoin Specialized:** Optimized prompts for identifying memecoin potential and risks.
- **Fast Execution:** Designed for quick entry and exit in volatile markets.
- **Risk Management:** Built-in rug check, wash trading detection, and smart money tracking.
- **Multi-Tool:** Integrated with Jupiter (price), GMGN (swaps), OKX (advanced risk signals), and Helius (wallet data).

## Core Mandates

1. **Security:** Never expose private keys.
2. **Data-Driven:** All trades must be justified by on-chain or API data.
3. **Autonomy:** Operates independently with configurable thresholds.

## Continuous Learning Skill

Ponyou is equipped with a **Continuous Learning** loop:
- **Observation:** Every screening cycle, Ponyou records candidates it *didn't* buy.
- **Evaluation:** Every 30 minutes, it checks the performance of these observed tokens (after 60 mins).
- **Gem/Trash Analysis:** Identifies "Missed Gems" and "Confirmed Trash" to refine filtering logic.
- **Success Analysis:** Analyzes profitable trades (PnL >= 20%) to reinforce winning patterns.
- **Auto-Lessons:** Findings are automatically added as lessons in `lessons.json` to guide future decisions.
- **Mode-Agnostic:** Operates in both Live and Dry Run modes.

## RTK Token Optimization (Experimental)

Ponyou now includes a native **RTK (Rust Token Killer)** style compression skill:
- **60-90% Token Savings:** Compresses tool outputs (tokens, holders, logs) before sending to LLM.
- **Smart Truncation:** Keeps the most relevant data while removing noise and redundant metadata.
- **Context Efficiency:** Allows Ponyou to handle longer sessions and more complex market data without hitting context limits.

## Usage

- `npm install`
- `cp .env.example .env` (Configure your RPC, Wallet, and OpenRouter keys)
- `npm run dev` (Dry run mode)
- `npm start` (Live mode)
