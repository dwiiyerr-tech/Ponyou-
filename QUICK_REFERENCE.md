# Ponyou Quick Reference — Cheat Sheet

## 🚀 Quick Start

```bash
# Setup pertama kali
npm install
./configure              # Atau: npm run setup

# Jalankan agent
npm start               # LIVE mode (DRY_RUN=false)
npm run dev            # DRY RUN mode (testing)
```

## ⏰ Cron Schedule (Default)

| Task | Interval | Function |
|------|----------|----------|
| **Screening** | Setiap 30 menit | Discover tokens, analyze, deploy |
| **Management** | Setiap 10 menit | Monitor positions, close if rules hit |
| **Health Check** | Setiap 60 menit | System health, balance sync |
| **Daily Report** | 00:05 UTC | Send summary via Telegram |
| **Vault Transfer** | Setiap 7 hari | Transfer 35% profit ke vault |

## 🎯 Main Concepts

### 1. **Screening Cycle** (30 min)
```
Find new tokens → Filter criteria → Agent analyzes → Deploy if good
```
- Discovers trending tokens via GMGN
- Filters by TVL, volume, holders, mcap
- Agent decides deploy or skip
- Records in state.json

### 2. **Management Cycle** (10 min)
```
Check open positions → Evaluate exit rules → Close if needed
```
- Monitors all active trades
- Checks: stop loss, take profit, trailing, ROI, rug
- Closes position if any rule hits
- Updates PnL, records outcome

### 3. **Session Gate** (Pilot Mode)
```
Daily target hit? → Pause 60 min → Resume after
Daily loss hit? → Learning mode 60 min → Resume after
```
- Target: 25% daily profit
- Stop loss: -10% daily loss
- Blocks entry when paused

### 4. **Learning Mode** (After loss)
```
Loss triggered → Activate 60 min pause
LLM analyzes: why did we lose?
Record lessons → Resume trading
```

## 📊 Config Quick Edit

**Essentials (in user-config.json):**

```json
{
  "pilotCapitalUsd": 10,          // Starting capital
  "dailyTargetPct": 25,           // Daily profit target %
  "deployAmountSol": 0.5,         // Per-trade size (SOL)
  "maxPositions": 3,              // Max open trades
  "stopLossPct": -50,             // Close if -50%
  "takeProfitPct": 5,             // Close if +5%
  "trailingTakeProfit": true,     // Trailing stop enabled
  
  // Filter
  "minTvl": 10000,                // Min TVL ($)
  "maxTvl": 150000,               // Max TVL ($)
  "minMcap": 150000,              // Min market cap ($)
  "maxMcap": 10000000,            // Max market cap ($)
  "minHolders": 500,              // Min holder count
  
  // Intervals
  "managementIntervalMin": 10,    // Check every X min
  "screeningIntervalMin": 30,     // Scan every X min
}
```

## 🛠️ Commands During Runtime

Type in CLI while agent running:

```bash
balance                    # Show wallet balance
position                   # List open trades
state                      # Show full state.json
lessons                    # Show lessons learned
plan                       # Show trading plan
sell MINT_ADDRESS          # Manual close
buy MINT_ADDRESS           # Manual entry (for testing)
config minTvl=50000        # Update setting on-fly
whitelist ADDR             # Approve address
blacklist ADDR             # Block address
pause                      # Pause agent
resume                      # Resume agent
quit                       # Exit gracefully
help                       # Show all commands
```

## 📱 Telegram Commands (v4)

All commands are **hot-applied** — no restart needed.

| Command | What it does |
|---------|-------------|
| `/menu` | Snapshot: active strategy, plan, pending intents, confirm mode |
| `/status` | Wallet + plan summary |
| `/pnl` | Last 10 trades as a table |
| `/strategy` | Show current active strategy |
| `/strategy <id>` | Switch active strategy (e.g. `/strategy sniper`) |
| `/strategies` | List all 5 presets with gates |
| `/stratset <id> <key> <value>` | Override one field (e.g. `/stratset sniper stoploss -0.20`) |
| `/confirm on\|off` | Toggle confirm mode at runtime |
| `/pending` | List BUY intents waiting for approval |
| `/yes <id>` | Approve & execute pending intent |
| `/no <id>` | Reject pending intent |

### Strategy Presets

| ID | SL | Trailing | Partial TP | LLM | Use case |
|----|-----|----------|------------|-----|----------|
| `scalping` (default) | -15% | on (20%/5%) | off | on | Default Ponyou, Freqtrade ROI on fresh pairs |
| `sniper` | -25% | on (20%/8%) | off | on (≥50%) | Strict fees, low mcap window, hard stops |
| `dip_buy` | -20% | on (10%/5%) | off | on (≥60%) | Wait for -40% dip from ATH on mature tokens |
| `smart_money` | -25% | off | 50% @ +100% | on (≥70%) | Higher mcap, partial TP at 100% then runner |
| `degen` | -15% | on (10%/4%) | off | **off** | Loose filters, tight stops, no LLM (rule-based) |

### `stratset` keys
`stoploss`, `trailing_enabled`, `trailing_offset`, `trailing_distance`,
`partial_tp_enabled`, `partial_tp_at`, `partial_tp_sell`,
`use_llm`, `llm_min_confidence`,
`min_mcap_usd`, `max_mcap_usd`, `min_holders`, `maxAllowedFlags`

## 📁 Important Files

| File | Purpose |
|------|---------|
| `user-config.json` | All settings ← Edit here via `./configure` |
| `.env` | Secrets (wallet, API keys) |
| `state.json` | Active positions (incl. `partial_tp_done` flag) |
| `trading-plan.json` | 30-day plan tracker |
| `lessons.json` | Rug history, best signals, analysis |
| `market-intelligence.json` | Market condition state |
| `active-strategy.json` *(v4)* | Currently active strategy preset ID — auto-created |
| `strategies-overrides.json` *(v4)* | Per-strategy field overrides set via `/stratset` |
| `pending-intents.json` *(v4)* | Pending BUY intents in confirm mode |
| `logs/agent-*.log` | Daily logs |
| `logs/actions-*.jsonl` | Trade execution log |

## 🔑 Environment Variables

Set in `.env` file:

```bash
# Required
WALLET_PRIVATE_KEY=your_base58_key_here
RPC_URL=https://pump.helius-rpc.com

# LLM (pick one)
OPENROUTER_API_KEY=sk-or-...        # Cloud
# OR
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-model-name

# API Keys
HELIUS_API_KEY=your_key
GMGN_ROUTE_KEY=your_key

# Optional
TELEGRAM_BOT_TOKEN=***
TELEGRAM_CHAT_ID=***
VAULT_WALLET=your_vault_address
DRY_RUN=true|false
```

## 🎮 Run Modes

```bash
npm start
# Full LIVE mode — real trading, real money

npm run dev
# DRY RUN — simulates but doesn't execute trades
# Good for testing config, agent reasoning

./configure
# Setup wizard interactive mode
```

## 📈 Metrics You Should Know

- **Daily P&L %**: `plan.today_pnl_pct`
- **Capital Growth**: `plan.capital_usd`
- **Win Rate**: `lessons.performance.win_rate_pct`
- **Largest Win**: `lessons.best_signals[0]`
- **Largest Loss**: `lessons.worst_signals[0]`
- **Rugs Avoided**: `lessons.rug_history.length`
- **Lessons Learned**: `lessons.analysis_count`

## 🚨 Troubleshooting

### Agent won't start
```bash
npm install                          # Missing deps
cat .env                             # Check API keys
node -v                              # Need Node 18+
```

### Getting 403 errors from GMGN
- Ensure browser-like headers in `tools/gmgn.js`
- Check GMGN_ROUTE_KEY in `.env`
- Wait (rate-limited)

### Positions not closing
- Check gate: is session paused?
- Check if stopped token in state
- Verify RPC + wallet access
- Check gas fees (SOL available)

### Config not applying
- Restart agent (`quit` then `npm start`)
- Or use `config` command in CLI
- Check user-config.json syntax

### Telegram not sending
- Set TELEGRAM_BOT_TOKEN
- Set TELEGRAM_CHAT_ID
- Test: `./configure` → 3. View config

## 🎯 Workflow at a Glance

```
STARTUP (load config, init plan)
    ↓
IDLE (wait for cron)
    ↓
┌────────────────────┐     ┌────────────────────┐
│   SCREENING (30m)  │     │  MANAGEMENT (10m)  │
│ Find + analyze +   │────▶│ Monitor + close +  │
│ deploy new tokens  │     │ record outcomes    │
└────────────────────┘     └────────────────────┘
    ↓
CHECK GATES
├─ Session pause? (target/loss)
├─ Learning mode? (analyzing loss)
└─ Vault running? (lock gates)
    ↓
REPEAT → Wait next cron
```

## 💡 Pro Tips

1. **Start small**: `pilotCapitalUsd: 10` and test with dry run first
2. **Watch logs**: `tail -f logs/agent-*.log` to understand decisions
3. **Enable Telegram**: Get alerts when targets/stops hit
4. **Daily reports**: Review every morning (00:05 UTC)
5. **Adjust criteria**: Too many rugs? Increase `minMcap`, `minHolders`
6. **Monitor market**: Check `market-intelligence.json` for adaptive thresholds
7. **Backup config**: `cp user-config.json user-config.backup.json`
8. **Lesson review**: Check `lessons.json` for patterns in wins/losses

## 📞 Commands Reference

```
╔════════════════════════════════════════╗
║         PONYOU CLI COMMANDS            ║
╠════════════════════════════════════════╣
║ INFO                                   ║
║  balance, position, state, lessons     ║
║  plan, help                            ║
║                                        ║
║ ACTION                                 ║
║  sell <mint>, buy <mint>              ║
║  config <key>=<val>                   ║
║  whitelist <addr>, blacklist <addr>   ║
║                                        ║
║ CONTROL                                ║
║  pause, resume, quit                  ║
╚════════════════════════════════════════╝
```

## 🔄 Day 30 Cycle

After 30 days (default), trading plan completes:
- Final P&L calculated
- Report generated
- Option to restart with new capital
- All lessons retained for next cycle

## 🎓 Learning Components

Ponyou remembers and learns from:

- ✅ **Winning signals**: Patterns that generated profit
- ❌ **Losing trades**: Why they exited early/late
- 🚩 **Rugs**: Dev addresses that exit scammed
- 📊 **Market states**: Hot/cold conditions
- 🧠 **LLM analysis**: Reasoning from loss analysis
- 📈 **Performance**: Win rate, PnL distribution

Check `/lessons.json` for all learned patterns!
