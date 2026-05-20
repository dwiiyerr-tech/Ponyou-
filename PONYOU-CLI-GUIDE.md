# PONYOU CLI - Complete Command-Line Interface Guide

Web-first CLI for managing all Ponyou features from the terminal.

> Note: the web dashboard is the primary surface now. Use `ponyou dashboard` only when you explicitly want the legacy terminal dashboard.

## 🚀 Quick Start

```bash
# Start main CLI
node ponyou-cli.js

# Open dashboard
ponyou dashboard

# LLM provider setup
node setup-llm.js

# Advanced management
node llm-cli.js help
```

---

## 📋 Main CLI Menu (`ponyou-cli.js`)

Interactive menu-driven interface for all Ponyou configuration and control.

### Features:

```
┌─────────────────────────────────────────────────────────┐
│  PONYOU CLI - LEGACY CONFIG MENU                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. ⚙️  Setup Wizard (Quick)                            │
│  2. 🔧 Advanced Configuration                           │
│  3. 🌐 LLM Provider Setup                               │
│  4. 📊 Status Snapshot                                  │
│  5. 📚 Documentation & Help                             │
│  6. 🧪 Test Configuration                               │
│  7. 🔄 Reset Configuration                              │
│  8. ❌ Exit                                              │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 🎯 Option 1: Setup Wizard (Quick)

```
⚙️ Quick setup starts here...

Configuration:
  - Provider: openrouter
  - Capital: $10
  - Max Positions: 3
  - Mode: DRY RUN

(Then you continue in the advanced config flow)
```

**What it does:**
- Validates configuration
- Prepares config and env values
- Keeps the legacy flow for manual config work
- Returns to the menu when done

---

## 🛠️ Option 2: Quick Setup Wizard

Guided setup for essential settings only (2-5 minutes).

### Steps:

```
1. WALLET & RPC
   └─ Enter private key
   └─ Configure RPC endpoint

2. LLM PROVIDER
   └─ Choose from: openrouter, groq, anthropic, openai, lmstudio
   └─ Enter API key (if needed)

3. TRADING SETUP
   └─ Initial capital ($10 default)
   └─ Daily profit target (25% default)

4. RISK MANAGEMENT
   └─ Max positions (3 default)
   └─ Stop loss (-15% default)

✅ Configuration saved!
```

**Files updated:**
- `user-config.json` - Config parameters
- `.env` - Private keys & API keys

---

## ⚙️ Option 3: Advanced Configuration

Detailed configuration with 8 sections:

### Sections:

#### 🌐 LLM Provider Settings
```
Current Provider: openrouter

Options:
1. Change provider
2. Change model
3. Test connection
4. Show configuration
5. Back
```

Available providers:
- `openrouter` - Default, multi-model (Claude, GPT, Mistral)
- `groq` - Free & very fast
- `anthropic` - Best reasoning (Claude)
- `openai` - GPT-4, GPT-3.5
- `mistral` - Mistral AI models
- `together` - Open source models
- `lmstudio` - Local (private)
- `ollama` - Local Docker

#### 💰 Pilot Mode (Trading Plan)
```
Compound Trading Configuration

Current Settings:
  - Initial Capital: $10
  - Daily Target: 25%
  - Daily Stop Loss: -10%
  - Plan Duration: 30 days

Options:
1. Change initial capital
2. Change daily target
3. Change daily stop loss
4. Change plan duration
5. Enable/Disable pilot mode
```

#### 📊 Screening Thresholds
```
Pool Selection Criteria

Current Settings:
  - Min TVL: $10,000
  - Max TVL: $150,000
  - Min Volume: $500
  - Min Holders: 500
  - Min Market Cap: $150,000
  - Max Market Cap: $10,000,000
  - Min Organic: 60%

Options:
1. Quick presets (conservative/balanced/aggressive)
2. Edit individual parameters
3. Reset to defaults
4. Back
```

**Presets:**
- **Conservative**: Low risk, strict filtering
- **Balanced**: Recommended (default)
- **Aggressive**: More opportunities, higher risk

#### 🛡️ Risk Management
```
Position & Loss Limits

Current Settings:
  - Max Positions: 3
  - Stop Loss: -15%
  - Take Profit: 5%
  - Trailing Stop: ON

Options:
1. Change max positions
2. Change stop loss
3. Change take profit
4. Toggle trailing stop
5. View risk summary
```

#### 📈 Strategy Settings
```
Trading Strategy

Current Strategy: instant_scalping

Available:
1. instant_scalping (default) - Quick scalps
2. momentum_trading - Trend following
3. value_accumulation - Long-term
4. custom - User-defined

Options:
1. Select strategy
2. Enable technical indicators
3. View strategy details
4. Back
```

#### ⏰ Scheduling
```
Cycle Intervals

Current Schedule:
  - Management: every 10 min
  - Screening: every 30 min
  - Health Check: every 60 min

Options:
1. Change management interval
2. Change screening interval
3. Change health check interval
4. Optimize for speed
5. Optimize for accuracy
6. Back
```

#### 💾 Vault Configuration
```
Auto Savings Settings

Current:
  - Enabled: YES
  - Savings %: 35%
  - Interval: every 7 days

Options:
1. Enable vault
2. Disable vault
3. Change savings percentage
4. Change interval
5. Back
```

#### 📱 Telegram Notifications
```
Alert Configuration

Options:
1. Setup telegram alerts
2. View setup instructions
3. Test notification
4. Disable alerts
5. Back
```

**Setup:**
1. Get bot token from @BotFather
2. Get chat ID from @userinfobot
3. Enter both values in setup

---

## 🌐 Option 4: LLM Provider Setup

Launches `setup-llm.js` for detailed LLM configuration.

See **LLM-CUSTOM-SETUP.md** for complete guide.

Quick options:
```
1. Setup Provider Baru
2. Switch Provider
3. Lihat Konfigurasi Sekarang
4. Info Provider
5. Validate Configuration
6. Edit Manual (.env)
7. Exit
```

---

## 📊 Option 5: Status Snapshot

View agent status and performance metrics.

```
📊 Configuration Status:

  Wallet.......................... ❌ Setup Wizard
  LLM Provider.................... ✅ openrouter
  Trading Plan.................... ✅ $10
  Risk Limits..................... ✅ 3 positions
  Screening....................... ✅ Configured

📁 Data Files:

  user-config.json............... ✅
  .env........................... ✅
  lessons.json................... ✅
  state.json..................... ✅

🔗 Quick Actions:

  1. View logs
  2. Check performance
  3. Clear lessons
  4. Reset state
  5. Back
```

---

## 📚 Option 6: Documentation & Help

View links to all documentation:

- `SETUP.md` - Main setup guide
- `SETUP-PROVIDERS.md` - LLM provider guide
- `LLM-CUSTOM-SETUP.md` - LLM custom tools
- `PONYOU-CLI-GUIDE.md` - This file

---

## 🧪 Option 7: Test Configuration

Validates all settings before running agent.

```
🧪 Running configuration tests...

  ✅ Config file readable - OK
  ✅ Environment variables loaded - OK
  ⚠️  LLM connection - Skipped
  ⚠️  Wallet configured - Skipped
  ⚠️  API keys valid - Skipped

Tests completed!
```

---

## 🔄 Option 8: Reset Configuration

⚠️ **WARNING**: This cannot be undone!

Clears all settings. Must type `reset` to confirm.

```
⚠️  WARNING: This will reset all configuration to defaults.
This cannot be undone.

Are you sure? Type 'reset' to confirm:
```

---

## 📊 Dashboard (`ponyou dashboard`)

Real-time monitoring dashboard.

```bash
ponyou dashboard
```

### Display:

```
╔══════════════════════════════════════════════════════════╗
║           PONYOU TRADING DASHBOARD                       ║
╚══════════════════════════════════════════════════════════╝

┌──────────────────────────────────────────────────────────┐
│ STATUS                                                    │
├──────────────────────────────────────────────────────────┤
│  Status: TRADING                                          │
│  Open Positions: 2                                        │
│  Mode: LIVE                                               │
│  Configuration: ✅                                        │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ PERFORMANCE                                               │
├──────────────────────────────────────────────────────────┤
│  Total Trades: 42                                         │
│  Win Rate: 65.5% (27W/15L)                                │
│  Avg P&L: +3.21%                                          │
│  Recent: +5.20%                                           │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ CONFIGURATION                                             │
├──────────────────────────────────────────────────────────┤
│  LLM Provider: groq                                       │
│  Trading Capital: $50                                     │
│  Max Positions: 3                                         │
│  Stop Loss: -15%                                          │
│  Daily Target: 25%                                        │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ LEARNING SYSTEM                                           │
├──────────────────────────────────────────────────────────┤
│  Active Lessons: 18                                       │
│  Total Lessons: 25                                        │
│  Learning Mode: OFF                                       │
│  Last Updated: 2 hours ago                                │
└──────────────────────────────────────────────────────────┘

QUICK ACTIONS:
  1. Legacy Agent      4. View Logs        7. Export Data
  2. Configuration      5. Test Setup       8. Reset All
  3. LLM Provider       6. Performance      9. Exit
```

**Auto-refreshes every 5 seconds**

Press `q` to exit.

---

## 🎮 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q` | Quit/Back |
| `Enter` | Select option |
| `Ctrl+C` | Stop agent |
| `1-9` | Menu selection |

---

## 📁 Configuration Files

### `user-config.json`
All trading parameters and settings (except secrets).

```json
{
  "llmProvider": "groq",
  "llmModel": "mixtral-8x7b-32768",
  "pilotCapitalUsd": 50,
  "dailyTargetPct": 25,
  "maxPositions": 3,
  "stopLossPct": -15,
  "strategy": "instant_scalping",
  "managementIntervalMin": 10,
  "screeningIntervalMin": 30
}
```

### `.env`
Sensitive data (passwords, API keys).

```bash
WALLET_PRIVATE_KEY=xxx
RPC_URL=https://pump.helius-rpc.com
LLM_PROVIDER=groq
GROQ_API_KEY=gsk-xxx
```

---

## 🔧 Advanced Commands

### Direct CLI access:

```bash
# LLM management
node llm-cli.js list
node llm-cli.js switch groq
node llm-cli.js validate
node llm-cli.js test groq

# Setup wizard
node setup-llm.js

# Dashboard
ponyou dashboard

# Start agent
npm start

# View logs
tail -f logs/agent-*.log
```

---

## 🚀 Typical Workflow

### First Time Setup:

```bash
# 1. Start CLI
node ponyou-cli.js

# 2. Choose "Setup Wizard"
# (or "Quick Setup")

# 3. Enter required info:
#    - Private key
#    - RPC URL
#    - LLM provider & API key
#    - Trading capital

# 4. Test setup
# (from main menu → Test Configuration)

# 5. Start agent
# (from legacy menu → legacy agent start)
```

### Daily Operations:

```bash
# Check dashboard
ponyou dashboard

# Monitor logs
tail -f logs/agent-*.log

# Adjust settings if needed
node ponyou-cli.js
# → Advanced Configuration
```

### Provider Switching:

```bash
# Quick switch
node llm-cli.js switch groq
node llm-cli.js set-key groq gsk-xxx

# Or use CLI
node ponyou-cli.js
# → LLM Provider Setup
```

---

## 🐛 Troubleshooting

### "Configuration file not found"
```bash
# Create default config
node ponyou-cli.js
# → Reset Configuration (if needed)
# → Setup Wizard
```

### "LLM provider not responding"
```bash
# Test connection
node llm-cli.js test <provider>

# Validate config
node ponyou-cli.js
# → Test Configuration
```

### "Agent won't start"
```bash
# Check configuration
node ponyou-cli.js
# → Status Snapshot

# Validate everything
node ponyou-cli.js
# → Test Configuration
```

---

## 💡 Tips & Tricks

### Use presets for quick setup:
```bash
node ponyou-cli.js
# → Advanced Configuration
# → Screening Thresholds
# → Quick presets
```

### Monitor while running:
```bash
# Terminal 1
node ponyou-cli.js
# → legacy agent start

# Terminal 2
ponyou dashboard
```

### Test before going live:
```bash
export DRY_RUN=true
node ponyou-cli.js
# → legacy agent start
```

### Switch providers easily:
```bash
node llm-cli.js switch groq
node llm-cli.js validate
npm start
```

---

## 📚 Related Documentation

- **SETUP.md** - Main setup guide
- **SETUP-PROVIDERS.md** - LLM provider details (9 providers)
- **LLM-CUSTOM-SETUP.md** - LLM custom tools (setup-llm.js, llm-manager.js, llm-cli.js)
- **ANALYSIS_REPORT.md** - Comprehensive analysis
- **.env.example** - Environment variable template

---

## ✨ Features

✅ Full interactive CLI
✅ All configuration options accessible
✅ Real-time dashboard with auto-refresh
✅ Configuration validation & testing
✅ Multiple LLM provider support
✅ Graceful error handling
✅ Color-coded output
✅ Context-aware menus
✅ Quick presets
✅ Help documentation

---

## 🎯 Summary

**Ponyou CLI gives you:**

1. **Interactive Menu** - No code knowledge needed
2. **Full Configuration** - Control all aspects
3. **Live Monitoring** - Real-time dashboard
4. **Easy Switching** - Change providers instantly
5. **Validation** - Test before running
6. **Documentation** - Built-in help

**Start with:**
```bash
node ponyou-cli.js
```

Enjoy! 🚀
