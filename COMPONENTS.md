# Ponyou Components — Detail Teknis

Penjelasan setiap module utama dan cara kerjanya.

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    index.js (MAIN)                      │
│  • Cron scheduler (node-cron)                          │
│  • Interactive CLI (readline)                          │
│  • Gate checks & cycle coordination                    │
└─────────────────────────────────────────────────────────┘
                     ↓ ↑
        ┌────────────┴─┴────────────┐
        ↓                           ↓
    ┌────────────┐          ┌──────────────┐
    │ agent.js   │          │ config.js    │
    │ ReAct loop │          │ Settings     │
    │ LLM calls  │          │ Defaults     │
    └────────────┘          └──────────────┘
        ↓ ↑
        │ └─▶ tools/executor.js (Tool dispatcher)
        │        ↓                                    ↑ confirm-mode intercept
        │    ┌────────────────────────────┐    ┌──────────────┐
        │    │ • gmgn.js (discovery/swap) │    │ intents.js   │
        │    │ • wallet.js (balance)      │    │ (v4 pending  │
        │    │ • strategy.js (exit rules) │    │  BUY queue)  │
        │    │ • definitions.js (schemas) │    └──────────────┘
        │    └────────────────────────────┘            ↑
        │                ↑                        Telegram /yes /no
        │                │ getStrategy()
        │         ┌──────────────┐
        │         │strategies.js │ (v4 preset registry +
        │         │5 presets +   │     hot active state)
        │         │overrides     │
        │         └──────────────┘
        │
        └─────────────────────────────────────┐
                                              ↓
    ┌─────────────┐  ┌────────────┐  ┌────────────────┐
    │ state.js    │  │lessons.js  │  │trading-plan.js │
    │ Positions   │  │Learning    │  │Compound track  │
    │ +partial_tp │  │Rug history │  │Session gate    │
    └─────────────┘  └────────────┘  └────────────────┘
                              │
                              ↓
    ┌──────────────────────────────────────┐
    │ market-intelligence.js               │
    │ • Market condition tracking          │
    │ • Adaptive thresholds                │
    │ • Signal weighting (Darwin)          │
    └──────────────────────────────────────┘
                              │
    ┌─────────────────────────┼────────────────────────┐
    ↓                         ↓                        ↓
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│ vault.js     │     │ telegram.js     │     │daily-report  │
│ Auto savings │     │ Notifications   │     │.js Report    │
└──────────────┘     └─────────────────┘     └──────────────┘
```

## 📄 Main Files Explained

### **index.js** — The Brain
**Purpose**: Main orchestrator, cron scheduler, interactive CLI
**What it does**:
- Loads config and initializes trading plan
- Sets up cron jobs for screening/management/health check/daily report/vault
- Runs interactive CLI for user commands
- Delegates to agent.js untuk screening/management cycles
- Manages gate checks (session pause, learning mode, vault)

**Key functions**:
- `checkAllGates()` — Verify if can proceed (3 gates)
- `runScreeningCycle()` — Find new tokens
- `runManagementCycle()` — Monitor positions
- `refreshSessionPnl()` — Check if daily target/loss hit
- `runLossAnalysis()` — LLM analyzes losses (learning mode)
- `runVaultCycle()` — Auto transfer profits

**When called**: Continuous, cron-driven

---

### **agent.js** — The Thinker (LLM)
**Purpose**: ReAct loop for autonomous decision making
**What it does**:
- Takes goal/prompt + system context
- Sends to LLM (OpenRouter or local)
- Parses response for tool calls
- Executes tools via executor.js
- Returns reasoning + final decision

**ReAct flow**:
```
1. Build system prompt (context + tools available)
2. Call LLM with tools schema
3. Parse response for tool calls (JSON)
4. Execute tool, get result
5. Loop: feed result back to LLM (if more thinking needed)
6. Return final decision
```

**Role-based**: Can be SCREENER, MANAGER, or GENERAL
- **SCREENER**: Find good tokens to deploy
- **MANAGER**: Decide close/hold for open position
- **GENERAL**: User commands, analysis

**Key functions**:
- `agentLoop(goal, maxSteps, initialTools, role, model, maxTokens)`

**When used**:
- Screening cycle: analyze token candidates
- Management cycle: decide exit for each position
- Learning mode: analyze losses

---

### **config.js** — The Settings
**Purpose**: Configuration management
**Where values loaded from**:
1. `user-config.json` (user overrides) ← TOP PRIORITY
2. Environment variables (.env)
3. Hardcoded defaults in this file

**Key exports**:
```javascript
export const config = {
  pilot: { enabled, initialCapitalUsd, dailyTargetPct, ... },
  vault: { walletAddress, pct, intervalDays },
  report: { enabled, hourUtc, minuteUtc },
  risk: { maxPositions, maxDeployAmount },
  screening: { minTvl, maxTvl, minVolume, ... },
  management: { deployAmountSol, stopLossPct, takeProfitPct, ... },
  schedule: { managementIntervalMin, screeningIntervalMin, ... },  llm: { temperature, maxTokens, maxSteps, ... },
  darwin: { enabled, windowDays, boostFactor, ... },
  tokens: { SOL, USDC, USDT },
  hiveMind: { url, apiKey, agentId, ... },
  indicators: { enabled, ... }
};
```

**Key functions**:
- `computeDeployAmount(walletSol)` — Calculate position size (scales with balance)
- `reloadScreeningThresholds()` — Refresh thresholds after evolution (hot-reload)

---

### **state.js** — The Tracker (Active Positions)
**Purpose**: Track all open positions
**File**: `state.json`
**What it stores**:
```json
{
  "positions": [
    {
      "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "entry_price": 0.0123,
      "entry_amount": 0.5,
      "entry_timestamp": 1683000000,
      "current_pnl_pct": 5.2,
      "raydium_position_id": "abc123..."
    }
  ]
}
```

**Key functions**:
- `trackPosition(mint, entryPrice, amount)` — Add new position
- `getTrackedPosition(mint)` — Get position details
- `recordClose(mint, exitPrice, reason)` — Mark as closed
- `syncOpenPositions()` — Query all Raydium LPs and update state
- `getStateSummary()` — Return total PnL, count, etc

**When updated**:
- Every deployment (add position)
- Every management cycle (update PnL)
- Every close (record exit)

---

### **trading-plan.js** — The Compound Tracker (Pilot Mode)
**Purpose**: Track 30-day compound plan with session gates
**File**: `trading-plan.json`
**What it stores**:
```json
{
  "days_total": 30,
  "day": 5,
  "initial_capital_usd": 10,
  "capital_usd": 12.50,
  "daily_target_pct": 25,
  "daily_stop_loss_pct": -10,
  "today_start_usd": 12.00,
  "today_start_timestamp": 1683000000,
  "today_pnl_pct": 4.17,
  "today_pnl_usd": 0.50,
  "profit_mode": false,
  "session_paused": false,
  "pause_until": null
}
```

**Session Gate Logic**:
- If `today_pnl_pct >= dailyTargetPct` → pause 60 min, set `profit_mode=true`
- If `today_pnl_pct <= dailyStopLossPct` → trigger learning mode, pause 60 min
- When paused, NO new entries until resume time

**Key functions**:
- `initTradingPlan()` — Create new plan
- `getTradingPlan()` — Get current plan
- `checkSessionGate()` — Verify if can proceed
- `updateSessionCapital(totalUsd)` — Refresh P&L, check if gate trigger
- `recordTrade(outcome)` — Log trade result
- `advanceDay()` — Move to next day
- `getPlanSummary()` — Return formatted summary

---

### **lessons.js** — The Memory (Learning)
**Purpose**: Persistent learning from trades
**File**: `lessons.json`
**What it stores**:
```json
{
  "rug_history": {
    "mint1": { "count": 3, "reason": "dev_exit", "blacklisted": true },
    "mint2": { "count": 1, "reason": "liquidity_drain", "blacklisted": false }
  },
  "dev_blacklist": ["dev_address_123", "dev_address_456"],
  "best_signals": [
    { "pattern": "early_organic_buy", "win_rate": 0.85 },
    { "pattern": "low_bundle_pct", "win_rate": 0.72 }
  ],
  "loss_analysis": [
    { "date": "2024-01-15", "reason": "rug_pull", "lessons": "check supply" }
  ],
  "performance": {
    "trades_total": 42,
    "trades_won": 28,
    "trades_lost": 14,
    "win_rate_pct": 66.7,
    "avg_win_pct": 8.3,
    "avg_loss_pct": -4.2,
    "best_trade_pct": 45.0,
    "worst_trade_pct": -50.0
  }
}
```

**Key functions**:
- `scoreRugRisk(tokenInfo)` — Predict rug likelihood (0-100)
- `recordRug(mint, reason)` — Log when rug detected
- `recordTradeOutcome(outcome)` — Update win/loss stats
- `getPerformanceSummary()` — Stats for display
- `getLessonsForPrompt()` — Format lessons for agent prompt
- `isTokenBlacklisted(mint)` — Check if in blocklist
- `isDevBlocked(address)` — Check if dev blacklisted

**When updated**:
- After every close (record outcome)
- Rug detected (record + block dev)
- Loss analysis run (add lessons)

---

### **market-intelligence.js** — The Analyst (Market State)
**Purpose**: Track market condition + adaptive thresholds
**File**: `market-intelligence.json`
**What it tracks**:
```json
{
  "last_snapshot_timestamp": 1683000000,
  "condition": "HOT",
  "volatility_score": 0.75,
  "trend": "up",
  "momentum": "strong",
  "recommended_thresholds": {
    "minMcap": 200000,
    "minVolume": 1000,
    "minOrganic": 70
  }
}
```

**Conditions**:
- **HOT**: Many new listings, high volatility, good for scalping
- **NORMAL**: Average market activity
- **COLD**: Few listings, low volume, risky

**Key functions**:
- `recordMarketSnapshot()` — Analyze current market
- `getMarketIntelligence()` — Return current condition
- `getRecommendedAdjustments()` — Suggest threshold tweaks

---

### **tools/executor.js** — The Tool Dispatcher
**Purpose**: Execute tools safely with permission checks
**What it does**:
- Validates tool exists and is allowed for role
- Parses arguments
- Calls tool function
- Handles errors gracefully
- Returns result or error

**Tool categories**:
- **Discovery**: `discover_tokens`, `get_token_info`, `get_token_security_details`
- **Execution**: `gmgn_swap`, `execute_trade`
- **State**: `get_wallet_balance`, `get_token_holders`
- **Admin**: `add_to_blacklist`, `block_deployer`, `self_update`
- **Info**: `get_plan_summary`, `get_market_intelligence`

**Key function**:
- `executeTool(toolName, args, role)` → result or error

---

### **tools/gmgn.js** — The Blockchain Interface
**Purpose**: All blockchain interactions (discovery, swap, security)
**Endpoints hit**:
- GMGN discovery (trending tokens)
- GMGN swap (execute trades)
- GMGN token info (price, volume, age)
- OKX advanced info (holder distribution)
- Jupiter audit (bot holder %

**Features**:
- Browser-realistic headers (avoid 403)
- Retry logic (3x on fail)
- Fallback endpoints
- Rate limiting

**Key functions**:
- `discoverTokens(options)` → list of candidates
- `swapToken(mint, amountIn, amountOut)` → execute swap
- `getTokenSecurityDetails(mint)` → rug risk score
- `getTokenInfo(mint)` → price, volume, holders, etc

---

### **tools/wallet.js** — The Wallet Interface
**Purpose**: Solana wallet operations
**What it does**:
- Sign transactions (private key from .env)
- Get balance (SOL + token balances)
- Monitor positions on Raydium

**Key functions**:
- `getWalletBalances()` → { sol, tokens, totalUsd }
- `signTransaction(tx)` → signed tx
- `sendTransaction(tx)` → broadcast + confirm

---

### **strategy.js** — The Exit Rules
**Purpose**: Determine if/when to close a position
**Exit rules checked** (all read from the *active* strategy preset on every call — see `strategies.js`):
1. **Stop Loss**: If PnL <= preset's `stoploss` → CLOSE
2. **Immediate TP** (hybrid override): user-config `takeProfitPct` if set → CLOSE
3. **Partial TP** *(v4)*: triggers once per position at preset's `partial_tp.at_pct`, sells `sell_pct%`, position stays open
4. **ROI table**: Freqtrade-style time-vs-profit ladder (per `marketCondition`)
5. **Trailing TP**: If hit `positive_offset`, then drop more than `positive_distance` → CLOSE
6. **Entry filter (4-protocol)**: gate gas fee, holder age, dust holders, pump ratio, wash trading, plus preset-specific gates (`min_mcap_usd`, `min_holders`, etc.)

**Key functions**:
- `getEffectiveStopLoss(userOverride)` → decimal SL
- `getEffectiveImmediateTakeProfit(userOverride)` → decimal TP or null
- `checkROI(ageMin, pnlPct, condition)` → `{exit, reason}`
- `checkTrailingStop(currentPnl, peakPnl)` → `{exit, reason}`
- `checkPartialTP(currentPnl, alreadyDone)` → `{trigger, sell_pct, reason}` *(v4)*
- `run4FilterProtocol(token, security, gas)` → `{passed, flags, action, score, strategy_id}`

---

### **strategies.js** *(v4)* — The Preset Registry
**Purpose**: 5 named strategy presets + hot-readable active-preset state.

**Presets shipped**:
| ID | SL | Trailing | Partial TP | LLM |
|----|-----|----------|-----------|-----|
| `scalping` *(default)* | -15% | 20%/5% | off | on |
| `sniper` | -25% | 20%/8% | off | on (≥50%) |
| `dip_buy` | -20% | 10%/5% | off | on (≥60%) |
| `smart_money` | -25% | off | 50%@+100% | on (≥70%) |
| `degen` | -15% | 10%/4% | off | **off** |

**Persistence**:
- `active-strategy.json` — `{ id, updated_at }` for current preset
- `strategies-overrides.json` — `{ [id]: { key: value } }` for per-field tweaks

Both files are read on every `getStrategy()` call → `/strategy` and `/stratset` commands hot-apply without restart.

**Key functions**:
- `getStrategy(id?)` → effective preset (with overrides merged)
- `getActiveStrategyId()` / `setActiveStrategy(id)`
- `setStrategyOverride(id, key, value)` / `clearStrategyOverrides(id?)`
- `listStrategies()` → array for `/strategies` Telegram command

---

### **intents.js** *(v4)* — Pending Trade Intents (Confirm Mode)
**Purpose**: Park BUYs as pending intents when `config.trading.confirmMode === true`. Approved manually via Telegram `/yes <id>`.

**Storage**: `pending-intents.json` — flat array with TTL (default 5 min). Expired entries are flipped to `status: "expired"` on every read.

**Status lifecycle**:
```
pending → executed   (user /yes, swap succeeded)
        → rejected   (user /no)
        → expired    (TTL passed)
        → failed     (swap call returned error)
```

**Key functions**:
- `createPendingIntent({ type, args, meta, ttl_min })` → intent
- `listPendingIntents()` → only `pending` entries (auto-expires stale)
- `getIntent(id)` / `consumeIntent(id, status, extra)`
- `gcIntents(keep_hours)` → garbage collect old resolved entries

**Wiring**:
- `tools/executor.js` → `maybeParkAsConfirmIntent(args)` intercepts `gmgn_swap` for SOL→token buys
- `index.js` → `executePendingIntent(id)` runs gmgnSwap + trackPosition when `/yes <id>` fires

---

### **prompt.js** — The System Prompt Builder
**Purpose**: Build context-aware system prompts for agent
**What it includes**:
- Agent role (SCREENER, MANAGER, GENERAL)
- Current wallet balance
- Open positions + PnL
- Trading plan status
- Market condition
- Lessons learned
- Available tools
- Task instructions

**Format**:
```
You are a Solana trading agent in SCREENER mode.
Current balance: $150.23
Open positions: 2 (total PnL +$8.50)
Market: HOT (high volatility)
Today's P&L: +3.2%
...
Available tools: [list]
...
Your task: [specific goal]
```

---

### **vault.js** — The Auto Savings
**Purpose**: Automatic profit transfer to savings wallet
**When triggered**: Every 7 days (or config interval)
**What it does**:
1. Calculate 35% of current profit
2. Keep gas reserve (0.2 SOL)
3. Execute transfer to vault wallet
4. Record transfer in vault-state.json
5. Send Telegram notification

**Key function**:
- `executeVaultTransfer(amountSol)` → tx hash

---

### **telegram.js** — The Messenger
**Purpose**: Send notifications to user
**Features**:
- Send simple text messages
- Format with emoji for readability
- Create/update live monitoring messages
- Start polling for user replies (optional)

**Key functions**:
- `sendMessage(text)` → send to chat
- `createLiveMessage(title)` → create updating message
- `startPolling()` → listen for commands
- `isEnabled()` → check if configured

---

### **daily-report.js** — The Historian
**Purpose**: Generate daily trading reports
**Triggered**: 00:05 UTC daily
**What includes**:
- Trades summary (count, win rate)
- P&L (total, best, worst)
- Lessons added
- Rugs avoided
- Market condition
- Plan progress

**Key function**:
- `generateDailyReport()` → report object
- `formatReportTelegram()` → pretty format

---

## 🔗 Data Flow Example

**User starts agent**
```
index.js startup
  ↓
Load config.js (user-config.json + .env + defaults)
  ↓
Initialize trading-plan.js (if pilot enabled)
  ↓
Start cron jobs:
  - screeningCron
  - managementCron
  - healthCheckCron
  - dailyReportCron
  - vaultCron
  ↓
Ready for CLI input + cron triggers
```

**Screening cycle fires (30 min)**
```
screeningCron
  ├─ checkAllGates() [trading-plan.js]
  │   ├─ checkSessionGate()
  │   ├─ getLearningModeStatus() [learning-mode.js]
  │   └─ isVaultDue() [vault.js]
  │
  ├─ discoverTokens(criteria) [tools/gmgn.js]
  │   └─ Filter by: timeframe, category, age
  │
  ├─ filterScreening(candidates)
  │   ├─ Check TVL, volume, holders, mcap [config.js]
  │   ├─ Fetch security details [tools/gmgn.js]
  │   └─ Score rug risk [lessons.js]
  │
  ├─ recordMarketSnapshot() [market-intelligence.js]
  │
  ├─ agentLoop(goal, tools=SCREENER) [agent.js]
  │   ├─ buildSystemPrompt() [prompt.js]
  │   │   ├─ Add lessons [lessons.js]
  │   │   └─ Add market intel [market-intelligence.js]
  │   │
  │   ├─ Call LLM with candidates
  │   ├─ Parse tool calls
  │   ├─ executeTool() [tools/executor.js]
  │   │   └─ dispatch to gmgn.js, wallet.js, etc
  │   └─ Return decision (DEPLOY or SKIP)
  │
  ├─ If DEPLOY:
  │   ├─ gmgnSwap() [tools/gmgn.js]
  │   ├─ trackPosition() [state.js]
  │   ├─ recordTrade() [trading-plan.js]
  │   └─ sendMessage() [telegram.js]
  │
  └─ If SKIP:
      └─ log reason (lessons.json)
```

**Management cycle fires (10 min)**
```
managementCron
  ├─ checkAllGates()
  │
  ├─ syncOpenPositions() [state.js]
  │   ├─ Query Raydium LPs [tools/wallet.js]
  │   └─ Update current PnL
  │
  ├─ FOR EACH position:
  │   ├─ run4FilterProtocol() [strategy.js]
  │   │   ├─ checkStackLoss(-50%)
  │   │   ├─ checkTrailingStop(+3% trigger, 1.5% drop)
  │   │   └─ checkROI()
  │   │
  │   ├─ If CLOSE signal:
  │   │   ├─ gmgnSwap() (exit) [tools/gmgn.js]
  │   │   ├─ recordClose() [state.js]
  │   │   ├─ recordTradeOutcome() [lessons.js]
  │   │   └─ sendMessage() [telegram.js]
  │   │
  │   └─ If HOLD:
  │       └─ continue monitoring
  │
  ├─ refreshSessionPnl() [index.js]
  │   ├─ Check if daily target hit
  │   ├─ Check if daily loss hit
  │   └─ Trigger pause/learning if needed
  │
  └─ updateTradingPlan() [trading-plan.js]
```

## 🎯 Summary

Setiap component punya satu job jelas:
- **index.js** = Orchestrator
- **agent.js** = Thinker (LLM)
- **config.js** = Settings
- **state.js** = Positions tracker
- **trading-plan.js** = Compound tracker + gates
- **lessons.js** = Memory + learning
- **market-intelligence.js** = Market analysis
- **tools/*.js** = External integrations
- **prompt.js** = Context builder
- **strategy.js** = Exit rules
- **vault.js** = Auto savings
- **telegram.js** = Notifications
- **daily-report.js** = Reporting

Semuanya bekerja together untuk autonomous trading! 🚀
