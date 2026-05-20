# Ponyou Workflow — Saat Agent Menjalankan Trading

Dokumentasi lengkap tentang apa yang terjadi ketika Ponyou sedang berjalan.

## 🌀 Overall Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PONYOU MAIN LOOP                         │
│                                                             │
│  ┌─────────────────┐      ┌─────────────────┐              │
│  │  Cron Scheduler │ ────▶│  Management     │              │
│  │  node-cron      │      │  Cycle (10min)  │              │
│  │                 │      └─────────────────┘              │
│  ├─────────────────┤                │                       │
│  │ - Management    │                ▼                       │
│  │ - Screening     │      ┌─────────────────┐              │
│  │ - Health check  │     │  Agent ReAct     │              │
│  │ - Daily Report  │     │  Loop + LLM      │              │
│  │ - Vault         │     └─────────────────┘              │
│  └─────────────────┘                │                       │
│         ▲                           ▼                       │
│         │                  ┌─────────────────┐              │
│         └──────────────────│   Tool Exec     │              │
│                            │  (GMGN, Wallet) │              │
│                            └─────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

## 🔄 Main Loop (Cron-based)

Ponyou berjalan dalam **cron intervals** yang terjadwal:

```javascript
// Dari config.schedule
managementIntervalMin:   10    // Check positions setiap 10 menit
screeningIntervalMin:    30    // Cari token baru setiap 30 menit
healthCheckIntervalMin:  60    // Health check setiap 60 menit
```

### Hierarchy Waktu

```
┌─ STARTUP (index.js:1) ───────────────────────────────────┐
│                                                           │
│ 1. Load config (.env, user-config.json)                 │
│ 2. Initialize trading plan jika pilot enabled            │
│ 3. Setup cron tasks:                                     │
│    - screeningCron (setiap X menit)                     │
│    - managementCron (setiap Y menit)                    │
│    - healthCheckCron (setiap Z menit)                   │
│    - dailyReportCron (scheduled time)                   │
│    - vaultCron (setiap N hari)                          │
│ 4. Setup Telegram (jika enabled)                         │
│ 5. Start interactive CLI                                 │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
    ┌──────────────────────────────────────────┐
    │   IDLE STATE - MENUNGGU CRON TRIGGER     │
    │   (User bisa input command di CLI)       │
    └──────────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
    MANAGEMENT        SCREENING          HEALTH
    (10 min)          (30 min)            (60 min)
```

## 📊 Screening Cycle (Cari Token Baru)

**Dijalankan setiap 30 menit** (atau interval di config)

```
START SCREENING
    │
    ▼
┌─────────────────────────────────────┐
│ CHECK ALL GATES                     │
├─────────────────────────────────────┤
│ • Session Pause? (target/loss hit)  │
│ • Learning Mode? (sedang belajar)   │
│ • Vault running? (lock gates)       │
└─────────────────────────────────────┘
    │
    ├─ YES BLOCKED ─▶ Skip cycle, log reason
    │
    └─ NOT BLOCKED ─▶ Continue
              │
              ▼
    ┌─────────────────────────────────────────┐
    │ DISCOVER TOKENS (GMGN API)             │
    ├─────────────────────────────────────────┤
    │ • Trending/category filter              │
    │ • Token age check                       │
    │ • Timeframe (5m, 15m, dll)             │
    │ Return: list of token candidates       │
    └─────────────────────────────────────────┘
              │
              ▼
    ┌─────────────────────────────────────────┐
    │ FILTER POOL SCREENING                  │
    ├─────────────────────────────────────────┤
    │ • Min TVL: $10k                         │
    │ • Max TVL: $150k                        │
    │ • Min volume: $500                      │
    │ • Min holders: 500                      │
    │ • Min mcap: $150k                       │
    │ • Max mcap: $10M                        │
    │ • Organic %: min 60%                    │
    │ • Bot holders: max 30%                  │
    │ • Top 10 concentration: max 60%         │
    │ • Exclude high supply conc: YES         │
    │ • Avoid/Block PVP symbols               │
    │ • Security check (rug risk)             │
    │ Return: filtered candidates             │
    └─────────────────────────────────────────┘
              │
              ▼
    ┌─────────────────────────────────────────┐
    │ RECORD MARKET SNAPSHOT                 │
    ├─────────────────────────────────────────┤
    │ • Market condition: HOT / NORMAL / COLD │
    │ • Volatility, trend, momentum signals   │
    │ • Feed ke market-intel.js               │
    └─────────────────────────────────────────┘
              │
              ▼
    ┌─────────────────────────────────────────┐
    │ CALL AGENT (SCREENER MODE)             │
    ├─────────────────────────────────────────┤
    │                                         │
    │ Input:                                  │
    │  • Candidates list                      │
    │  • Market condition                     │
    │  • Lessons learned (rug history, etc)  │
    │  • Risk scores                          │
    │                                         │
    │ Agent Tools Available:                  │
    │  • discover_tokens                      │
    │  • get_token_security_details           │
    │  • get_solana_gas_fee                  │
    │  • get_token_holders                   │
    │  • get_token_info                      │
    │  • get_wallet_balance (info only)      │
    │                                         │
    │ Output:                                 │
    │  • Reasoning (why good/bad)            │
    │  • Recommendation: DEPLOY or SKIP      │
    │  • Rug risk score                      │
    │                                         │
    └─────────────────────────────────────────┘
              │
              ▼
    ┌──────────────────────────────────┐
    │ SHOULD DEPLOY? Check criteria    │
    ├──────────────────────────────────┤
    │ • Max positions limit not hit     │
    │ • Wallet balance sufficient      │
    │ • No repeat deploy cooldown      │
    │ • All gates clear                │
    │ • Risk score acceptable          │
    │ • Not blacklisted/blocked        │
    └──────────────────────────────────┘
              │
    ┌─────────┴─────────┐
    ▼                   ▼
  DEPLOY            SKIP + LOG
  │                 │
  ▼                 ▼
EXECUTE        Record in lessons.json
SWAP           (missed opportunity)
│
Event log:
- timestamp
- token mint
- entry reason
- contract addr
- initial amount

END SCREENING
```

## 💰 Management Cycle (Kelola Posisi Buka)

**Dijalankan setiap 10 menit** (atau interval di config)

```
START MANAGEMENT
    │
    ▼
┌─────────────────────────────────────┐
│ CHECK ALL GATES                     │
├─────────────────────────────────────┤
│ • Session Pause?                    │
│ • Learning Mode?                    │
│ • Vault running?                    │
└─────────────────────────────────────┘
    │
    ├─ BLOCKED ─▶ Skip
    │
    └─ NOT BLOCKED
              │
              ▼
    ┌──────────────────────────────────────┐
    │ SYNC OPEN POSITIONS                  │
    ├──────────────────────────────────────┤
    │ • Query Raydium LPs (wallet)         │
    │ • Cross-check state.json             │
    │ • Update current PnL                 │
    │ • Detect closes (tidak detected)     │
    └──────────────────────────────────────┘
              │
              ▼
    FOR EACH OPEN POSITION:
         │
         ├─ Position A
         │    └─▶ [Check exit rules]
         │
         ├─ Position B
         │    └─▶ [Check exit rules]
         │
         └─ Position C
              └─▶ [Check exit rules]
              │
              ▼
      ╔═══════════════════════════════════╗
      ║    POSITION EXIT CHECK            ║
      ╠═══════════════════════════════════╣
      ║ • Current price vs entry         ║
      ║ • Current PnL %                  ║
      ║ • Stop Loss triggered? (-50%)    ║
      ║ • Take Profit triggered? (+5%)   ║
      ║ • Trailing TP active?            ║
      ║   - Triggered at +3%             ║
      ║   - Drop 1.5% from peak?        ║
      ║ • ROI check poor?                ║
      ║ • Pool out of range?             ║
      ║ • Rug detected?                  ║
      ║ • Low yield check?               ║
      ║ • Time-based close?              ║
      ╚═══════════════════════════════════╝
              │
    ┌─────────┴──────────┐
    ▼                    ▼
  CLOSE (YES)         HOLD (NO)
  │                   │
  ▼                   ▼
Execute Exit       Continue Monitor
Swap              │
│                 └─▶ Wait next cycle
Update state.json
Record trade:
- exit time
- exit price
- final PnL
- reason (SL/TP/rug/etc)
- lessons if needed

        ┌─────────────────┐
        │ TRIGGER ACTIONS │
        └─────────────────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
  PROFIT  LOSS      RUG
  HIT     HIT      DETECTED
  │       │         │
  ▼       ▼         ▼
Pause   Learn    Block+Log
Session Mode    Dev
60min   60min
Send    Send    Record
Telegram Telegram Lessons
│       │         │
Resume  Resume    Update
Later   Later     Blacklist

END MANAGEMENT
```

## 🧠 Agent ReAct Loop (Ketika Dipanggil)

Ponyou menggunakan **ReAct pattern** dengan LLM:

```
AGENT LOOP START
    │
    ▼
┌─────────────────────────────────────────────┐
│ 1. BUILD SYSTEM PROMPT                      │
├─────────────────────────────────────────────┤
│ • Role: SCREENER atau MANAGER              │
│ • Current state (positions, balance)        │
│ • Market intelligence                       │
│ • Recent lessons (rug history)             │
│ • Available tools                           │
│ • Task/goal                                 │
│ • Risk constraints                          │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 2. SEND TO LLM with Tool Definitions        │
├─────────────────────────────────────────────┤
│ Request: Think + decide + call tools        │
│ Response: Reasoning + tool_name + args      │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 3. PARSE RESPONSE                           │
├─────────────────────────────────────────────┤
│ • Extract <think> blocks                    │
│ • Find tool calls in JSON                   │
│ • Validate tool name exists                 │
│ • Repair malformed JSON if needed           │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 4. EXECUTE TOOL                             │
├─────────────────────────────────────────────┤
│ • Check tool permissions (MANAGER/SCREENER) │
│ • Execute tool with args                    │
│ • Catch errors gracefully                   │
│ • Return result as JSON                     │
└─────────────────────────────────────────────┘
    │
    └─▶ [Return to LLM as tool_result]
              │
              ▼
    ┌──────────────────────────────┐
    │ Loop? (ReAct iterations)     │
    ├──────────────────────────────┤
    │ • Max loops: 20             │
    │ • Max tokens: 4096          │
    │ • Stop tokens: <end>, done  │
    └──────────────────────────────┘
             │
    ┌────────┴────────┐
    ▼                 ▼
  CONTINUE          DONE
  Another           Return
  tool call         Final
  (loop)            output
   │
   └─▶ [Go to step 3 again]

AGENT LOOP END
    │
    ▼
Return final decision to caller
```

## 🔐 Gate System — Access Control

Sebelum screening/management berjalan, cek:

```
┌──────────────────────────────────────────┐
│           GATE CHECKS (checkAllGates)    │
├──────────────────────────────────────────┤
│                                          │
│ 1. SESSION PAUSE GATE                   │
│    ├─ Daily target hit? → pause 60min   │
│    ├─ Daily loss hit? → pause + learn   │
│    └─ Resume time passed? → continue    │
│                                          │
│ 2. LEARNING MODE GATE                   │
│    ├─ Loss analysis ongoing?  → blocked │
│    ├─ Learning duration passed? → free  │
│    └─ Run LLM analysis once             │
│                                          │
│ 3. VAULT CYCLE GATE                     │
│    ├─ Vault running? → lock management  │
│    └─ Vault done? → continue            │
│                                          │
└──────────────────────────────────────────┘
```

## 📋 Daily Report Cycle

**Scheduled time: 00:05 UTC (configurable)**

```
⏰ CRON: "5 0 * * *" (5 menit past midnight UTC)
    │
    ▼
┌──────────────────────────────────────────┐
│ 1. GENERATE REPORT                       │
├──────────────────────────────────────────┤
│ • Summary all trades (24h)               │
│ • Win rate %                             │
│ • Total PnL USD/SOL                      │
│ • Best trade                             │
│ • Worst trade                            │
│ • Lessons learned count                  │
│ • Rug detections                         │
│ • Sessions ruined  (%)                  │
│ • Market condition (hot/normal/cold)     │
│ • Trading plan progress                  │
│ • Vault transfers (if any)               │
└──────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────┐
│ 2. SEND via TELEGRAM (if enabled)        │
├──────────────────────────────────────────┤
│ Formatted message with emoji             │
│ Sendto: TELEGRAM_CHAT_ID                 │
└──────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────┐
│ 3. SAVE TO FILE (daily-report.json)      │
├──────────────────────────────────────────┤
│ • Date, summary, trades array            │
│ • Appended for history                   │
└──────────────────────────────────────────┘
```

## 🏦 Vault Transfer Cycle

**Cron: setiap 7 hari (configurable)**

```
VAULT DUE? (checkAllGates + isVaultDue)
    │
    ├─ No ──▶ Skip
    │
    └─ Yes
         │
         ▼
    ┌──────────────────────────────────────┐
    │ COMPUTE VAULT AMOUNT                 │
    ├──────────────────────────────────────┤
    │ • Get wallet balance                 │
    │ • Calculate 35% of profit            │
    │ • Keep min reserve for trading       │
    └──────────────────────────────────────┘
         │
         ▼
    ┌──────────────────────────────────────┐
    │ EXECUTE TRANSFER                     │
    ├──────────────────────────────────────┤
    │ • Sign transaction                   │
    │ • Send to VAULT_WALLET              │
    │ • Confirm on chain                   │
    └──────────────────────────────────────┘
         │
         ▼
    ┌──────────────────────────────────────┐
    │ RECORD & NOTIFY                      │
    ├──────────────────────────────────────┤
    │ • Update vault-state.json            │
    │ • Send Telegram notification         │
    │ • Log in transactions                │
    └──────────────────────────────────────┘
```

## 📊 State Files — Persistence

Semua state disimpan dalam file JSON:

```
├─ user-config.json         — Configuration (user settings)
│  └─ Scores: pilotCapitalUsd, strategy, minTvl, etc
│
├─ state.json               — Active positions
│  └─ Array of open trades: {mint, entry_price, amount, timestamp}
│
├─ trading-plan.json        — Compound plan tracker
│  ├─ day: current day (1/30)
│  ├─ capital_usd: running balance
│  ├─ daily_pnl_pct: today's P&L %
│  ├─ today_start_usd: start of day balance
│  └─ profit_mode: track if session paused on +target
│
├─ lessons.json             — Learning history
│  ├─ rug_history: mintdict -> { count, reason, blacklisted }
│  ├─ dev_blacklist: deployer addresses that rug
│  ├─ best_signals: patterns yang profitable
│  ├─ loss_analysis: LLM analysis dari losing trades
│  └─ performance: trade outcomes + metrics
│
├─ market-intelligence.json — Market state
│  ├─ last_snap: snapshot timestamp
│  ├─ condition: "HOT" / "NORMAL" / "COLD"
│  ├─ volatility: score
│  ├─ trend: up/down/sideways
│  └─ recommendations: adaptive thresholds
│
├─ logs/agent-YYYY-MM-DD.log    — Daily logs
│  └─ All agent actions + reasoning
│
├─ logs/actions-YYYY-MM-DD.jsonl — Trade exec log
│  └─ Line-by-line: each action, each tool call
│
└─ .env                     — Environment (secrets)
   ├─ WALLET_PRIVATE_KEY
   ├─ RPC_URL
   ├─ OPENROUTER_API_KEY
   ├─ HELIUS_API_KEY, BIRDEYE_API_KEY
   └─ TELEGRAM credentials
```

## 🔄 Example: Full Cycle (1 screening + 1 management)

```
TIME: 14:00 UTC (example)
═════════════════════════════════════════════

14:00:00 — SCREENING CRON FIRE
┌─────────────────────────────────────────┐
│ 1. Check gates → all clear              │
│ 2. Discover tokens (GMGN)               │
│    Result: 50 tokens trending           │
│ 3. Filter criteria                      │
│    Result: 8 pass screening             │
│ 4. Agent analyzes:                      │
│    - Token A: no (low volume)           │
│    - Token B: YES ✓ (deploy!)          │
│    - Token C: no (high rug risk)        │
│    - Token D-H: no                      │
│ 5. Execute deploy for Token B           │
│    - Entry swap: 0.5 SOL                │
│    - Record in state.json               │
│    - Send Telegram alert                │
│ 6. Log: 7 missed opportunities          │
└─────────────────────────────────────────┘

14:10:00 — MANAGEMENT CRON FIRE
┌─────────────────────────────────────────┐
│ 1. Check gates → all clear              │
│ 2. Sync positions:                      │
│    - Token B (from 14:00): +3.2% PnL    │
│ 3. Check exit rules:                    │
│    - Stop loss -50%? No                 │
│    - Take profit +5%? No                │
│    - Trailing: active, check drop 1.5%  │
│    - Low yield? No                      │
│    → Decision: HOLD                     │
│ 4. Log: position healthy, continue      │
│ 5. Update wallet balance display        │
└─────────────────────────────────────────┘

14:20:00 — MANAGEMENT CRON FIRE (2x)
┌─────────────────────────────────────────┐
│ 1. Check gates → all clear              │
│ 2. Sync positions:                      │
│    - Token B: now +7.8% PnL             │
│ 3. Check exit rules:                    │
│    - Trailing triggered at +3% ✓        │
│    - Current: +7.8% (peak)              │
│    - Check if drop 1.5% from peak...    │
│    → Decision: HOLD (not yet dropped)   │
│ 4. Log: trailing active, monitoring     │
└─────────────────────────────────────────┘

14:22:00 — MANAGEMENT CRON FIRE (3x)
┌─────────────────────────────────────────┐
│ 1. Check gates → all clear              │
│ 2. Sync positions:                      │
│    - Token B: now +6.1% PnL             │
│ 3. Check exit rules:                    │
│    - Trailing peak: +7.8%               │
│    - Drop from peak: 2.1%               │
│    - Required drop: 1.5% ✓ TRIGGERED   │
│    → Decision: CLOSE!                   │
│ 4. Execute exit swap:                   │
│    - Receive tokens back                │
│    - Swap to SOL                        │
│    - Final PnL: +6.1%                   │
│ 5. Update session PnL:                  │
│    - Daily target: 25% → hit? No        │
│    - Daily loss: -10% → hit? No         │
│ 6. Update trading-plan.json:            │
│    - today_pnl_pct: +6.1%              │
│    - capital_usd: increased 6.1%        │
│ 7. Record trade in lessons.json         │
│ 8. Send Telegram:                       │
│    "✅ Closed Token B: +6.1% P&L"       │
│ 9. Log: trade recorded, state updated   │
└─────────────────────────────────────────┘

14:30:00 — NEXT SCREENING CRON FIRE
┌─────────────────────────────────────────┐
│ [Repeat screening process]              │
│ [Continue cycle...]                     │
└─────────────────────────────────────────┘
```

## 🎮 Interactive CLI Commands

**User bisa input command kapan saja:**

```bash
balance          # Show wallet balance
position         # List open positions
state            # Show trading state
lessons          # Show lessons learned
plan             # Show trading plan
sell <token>     # Manual close position
buy <token>      # Manual deploy
config <key>=<val>  # Update config on fly
whitelist <addr> # Add to allow-list
blacklist <addr> # Block address
pause            # Pause agent
resume           # Resume agent
quit             # Exit agent (graceful)
```

## 🎯 Strategy Switching Flow (v4)

```
USER (Telegram): /strategy sniper
        ↓
handleStrategyTelegramCommand()  [index.js]
        ↓
setActiveStrategy("sniper")      [strategies.js]
        ├─▶ writes active-strategy.json: {"id":"sniper", ...}
        └─▶ Telegram reply: "✅ Switched to Sniper"

Next management cycle:
        ↓
checkDeterministicExits()
        ├─ getEffectiveStopLoss()   ─▶ getStrategy()
        ├─ checkROI()               ─▶ getStrategy()  (reads active-strategy.json)
        ├─ checkPartialTP()         ─▶ getStrategy()  ← all return "sniper" preset now
        └─ checkTrailingStop()      ─▶ getStrategy()

Next screening cycle:
        ↓
run4FilterProtocol()              ─▶ getStrategy().filters  ← sniper gates apply

NO RESTART NEEDED — `/stratset sniper stoploss -0.20` works the same way
via strategies-overrides.json.
```

## 🟡 Confirm Mode Flow (v4)

Aktifkan: `user-config.json { "confirmMode": true }` atau `CONFIRM_MODE=true`.

```
SCREENING CYCLE
        ↓
LLM picks candidate → invokes swap_token(token_in:"SOL", token_out:"XXX")
        ↓
executor.js → maybeParkAsConfirmIntent(args)     ← intercept here
        ├─ confirmMode === true?           YES
        ├─ args.token_in === "SOL"?        YES (it's a BUY)
        ├─ DRY_RUN !== "true"?             YES
        ↓
createPendingIntent({
  type: "buy",
  args: {token_in, token_out, amount},
  meta: {strategy_id: "sniper"},
  ttl_min: 5
})  ─▶ pending-intents.json
        ↓
Telegram: 🟡 Pending BUY — approval needed
          Intent: #3
          Strategy: sniper
          Amount: 0.1 SOL
          Token: XXX111...
          Reply /yes 3 or /no 3
        ↓
return { pending: true, intent_id: 3, message: "Awaiting approval..." }
        ↓ (LLM sees pending, stops retrying)

──── meanwhile ────

USER (Telegram): /yes 3
        ↓
executePendingIntent(3)           [index.js]
        ├─ getIntent(3) → check status="pending" & not expired
        ├─ swapToken(intent.args)  ← actual swap
        ├─ getTokenInfo() + getWalletBalances()  ← resolve symbol + price
        ├─ trackPosition({ position, pool_name, amount_sol, initial_value_usd })
        ├─ recordTrade(null)
        ├─ consumeIntent(3, "executed", {result: tx_hash})
        └─ Telegram: "✅ Intent #3 executed."

         OR

USER (Telegram): /no 3
        ↓
consumeIntent(3, "rejected") → "🚫 Intent #3 rejected."

         OR

TTL expires (5 min)
        ↓
listPendingIntents() flips status → "expired" automatically
```

**Toggle confirm mode runtime tanpa restart:**
```
/confirm off   → config.trading.confirmMode = false (until next bot restart)
/confirm on    → config.trading.confirmMode = true
```

Untuk persist lewat restart, set `confirmMode: true` di `user-config.json`.

## 🔄 Session Pause Example

```
SCENARIO: Daily profit target hit (25%)

14:45:00 — During screening
├─ Current balance: $106.25 (was $100)
├─ Daily gain: +6.25% (so far)
├─ Next deploy would make +32.5%% (exceeds 25% target)
├─ refreshSessionPnl() triggered:
│   └─ action: "pause_target"
│
├─ PAUSE SESSION:
│   ├─ Mark session.paused = true
│   ├─ Resume time: now + 60 minutes = 15:45
│   ├─ Set profit_mode = true in trading-plan
│   ├─ Log & Telegram:
│   │   "🎯 TARGET TERCAPAI! +25.5%
│   │    Dijeda 60min untuk istirahat.
│   │    Profit mode: ON 🔥"
│   │
│   └─ Skip current + next screening attempts
│
15:00:00 — Screening runs
├─ checkSessionGate() says: "paused, resume in 45m"
├─ Skip screening entirely
│
15:45:00 — 60 minutes elapsed
├─ checkSessionGate() says: "just_resumed"
├─ Log: "Session resumed"
├─ Telegram: "▶️ Sesi dilanjutkan. Day 5/30"
├─ Resume normal screening/management
│
└─ Continue trading...
```

## 🎯 Kesimpulan

**Flow Ponyou:**

1. **Startup** → Load config, init trading plan, start crons
2. **Idle** → Wait untuk cron fire
3. **Screening (30min)** → Discover tokens → Agent analyze → Deploy if good
4. **Management (10min)** → Monitor positions → Check exit rules → Close if needed
5. **Gates** → Session pause/learning mode blocks entry
6. **Daily Report (00:05 UTC)** → Summary 24h, send Telegram
7. **Vault (7d)** → Transfer profit to savings
8. **Loop** → Back to idle, tunggu next cron

Konfigurasi atom sekarang dikelola langsung lewat file runtime agent.
