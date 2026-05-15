# PONYOU CLI COMPLETE - Claude Code Version for Ponyou

**Unified Command-Line Interface untuk manage semua Ponyou features**

Mirip seperti Claude Code, tapi untuk autonomous trading agent!

---

## 🚀 QUICK START

### **Opsi 1: Main Launcher (Recommended)**
```bash
node ponyou-launcher.js
```

Single entry point untuk semua fitur dengan interactive menu.

### **Opsi 2: Quick Dashboard**
```bash
node ponyou-dashboard.js
```

Real-time monitoring (auto-refresh 5 detik).

### **Opsi 3: Comprehensive Monitor**
```bash
node ponyou-monitor.js
```

Detailed metrics, risk analysis, lesson tracking.

### **Opsi 4: Configuration Menu**
```bash
node ponyou-cli.js
```

Advanced configuration untuk semua aspek.

### **Opsi 5: LLM Provider Tools**
```bash
node setup-llm.js        # Interactive setup wizard
node llm-cli.js list      # Quick CLI commands
node llm-manager.js       # Programmatic access
```

---

## 📱 MAIN LAUNCHER: `ponyou-launcher.js`

**Main entry point - Satu interface untuk semua!**

```bash
node ponyou-launcher.js
```

### Main Menu Options:

```
┌────────────────────────────────────────┐
│  🐎 PONYOU - AI TRADING AGENT CLI 🐎  │
│    Claude Code Version for Ponyou     │
└────────────────────────────────────────┘

  1. 🚀 Start Agent         Run trading agent
  2. 📊 Dashboard           Real-time monitoring
  3. 📈 Monitor            Comprehensive metrics
  4. ⚙️  Configuration      Setup & settings
  5. 🌐 LLM Provider        Provider management
  6. 🧪 Test System        Validation & tests
  7. 📚 Documentation      Help & guides
  8. 📁 File Manager       Config files
  9. ❌ Exit                Quit Ponyou CLI
```

---

## 🎯 DETAILED MENU FLOWS

### **1. Start Agent**

```
STARTING PONYOU TRADING AGENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Pre-flight Checks:

  ✓ Config file readable
  ✓ Environment variables loaded
  ✓ Trading capital configured
  ✓ Max positions configured

✓ All checks passed. Starting agent...

Tekan Ctrl+C untuk stop agent
```

**Fitur:**
- Pre-flight validation sebelum start
- Real-time logs dari agent
- Graceful shutdown dengan Ctrl+C
- Error detection dan reporting

---

### **2. Dashboard**

```
╔══════════════════════════════════════════════════════╗
║           PONYOU TRADING DASHBOARD                   ║
╚══════════════════════════════════════════════════════╝

┌──────────────────────────────────────────────────────┐
│ STATUS                                                │
├──────────────────────────────────────────────────────┤
│  Status: TRADING (🟢)                                │
│  Open Positions: 2                                    │
│  Mode: LIVE                                           │
│  Configuration: ✅                                    │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ PERFORMANCE                                           │
├──────────────────────────────────────────────────────┤
│  Total Trades: 42                                     │
│  Win Rate: 65.5% (27W/15L) - 🟢 EXCELLENT           │
│  Avg P&L: +3.21%                                     │
│  Recent: +5.20% - 🟢 UP                              │
└──────────────────────────────────────────────────────┘

[... dan seterusnya ...]

🔄 Auto-refresh setiap 5 detik
Tekan 'q' untuk exit
```

**Features:**
- Auto-refresh 5 detik
- Color-coded metrics
- 5 main sections
- Quick action menu

---

### **3. Monitor (Comprehensive)**

```
╔═══════════════════════════════════════════════════════╗
║           PONYOU COMPREHENSIVE MONITOR                ║
╚═══════════════════════════════════════════════════════╝

📊 STATUS OVERVIEW
  Current Status: 🟢 TRADING
  Open Positions: 2 / 3
  Mode: 🔴 LIVE
  Last Update: 15:42:30

📈 TRADING PERFORMANCE
  Total Trades: 42
  Wins: 27 | Losses: 15
  Win Rate: 64.3%
  Avg P&L: +3.21%
  Total P&L: +135%
  Best Trade: +125%
  Worst Trade: -35%
  Consecutive Wins: 3

⚠️  RISK METRICS
  Max Drawdown: -12.5%
  Sharpe Ratio: 1.28
  Risk Score: 0.95
  Position Utilization: 66%
  Peak Equity: $1,350
  Current Equity: $1,182

⚙️  CONFIGURATION
  Provider: Groq
  Model: mixtral-8x7b-32768
  Capital: $50
  Max Positions: 3
  Stop Loss: -15%
  Daily Target: 25%

🧠 LEARNING SYSTEM
  Active Lessons: 18 / 25
  Learning Mode: OFF
  Top Lessons:
    84% - Skip tokens dengan fee > 1%
    78% - Avoid tokens from same creator
    72% - Check holder concentration

📊 RECENT TRADES
  1. ABC - +5.2% ✓
  2. XYZ - -3.1% ✗
  3. DEF - +8.5% ✓
  4. GHI - +2.3% ✓
  5. JKL - -1.2% ✗

💼 OPEN POSITIONS
  ABC        - Entry: $12.50 | P&L: +24.5%
  XYZ        - Entry: $8.75  | P&L: -8.2%
```

**Metrics Explained:**
- **Sharpe Ratio** - Return vs volatility (>1 = good)
- **Risk Score** - Lower is safer
- **Max Drawdown** - Largest peak-to-trough decline
- **Win Rate** - Percentage of profitable trades
- **Consecutive** - How many wins in a row

---

### **4. Configuration**

Launches `ponyou-cli.js` dengan menu penuh:

```
ADVANCED CONFIGURATION MENU

1. 🌐 LLM Provider Settings
   - Change provider (9 options)
   - Change model
   - Test connection
   - View config

2. 💰 Pilot Mode
   - Initial capital
   - Daily target
   - Stop loss %
   - Plan duration

3. 📊 Screening Thresholds
   - 3 quick presets
   - Manual editing
   - Min TVL, Max TVL, Min Volume, Holders

4. 🛡️  Risk Management
   - Max positions
   - Stop loss
   - Take profit
   - Trailing stop

5. 📈 Strategy Settings
   - Select strategy
   - Enable indicators
   - View details

6. ⏰ Scheduling
   - Management interval
   - Screening interval
   - Health check interval

7. 💾 Vault Configuration
   - Enable/disable
   - Savings %
   - Interval

8. 📱 Telegram Notifications
   - Setup alerts
   - Test notification
   - Disable
```

---

### **5. LLM Provider**

```
LLM PROVIDER MANAGEMENT

1. 🔄 Switch Provider
   - openrouter (default)
   - openai (GPT-4)
   - anthropic (Claude)
   - groq (FREE & FAST)
   - mistral
   - together
   - lmstudio (local)
   - ollama (docker)

2. 🔑 Set API Key
   node llm-cli.js set-key groq gsk-xxxxx

3. ✅ Validate Config
   node llm-cli.js validate

4. 🧪 Test Connection
   node llm-cli.js test groq

5. 📚 Setup Wizard
   node setup-llm.js (interactive)

6. 📋 View Current
   node llm-cli.js current

Quick Commands:
  # List all
  node llm-cli.js list

  # Switch & set key in 2 commands
  node llm-cli.js switch groq
  node llm-cli.js set-key groq gsk-xxxxx

  # Validate everything
  node llm-cli.js validate
```

---

### **6. Test System**

```
SYSTEM TESTING
━━━━━━━━━━━━━━━━━

Running tests...

  ✓ Config file
  ✓ State file
  ✓ Lessons file
  ✓ Performance file
  ✓ Environment variables

✓ All tests passed!
```

---

### **7. Documentation**

```
DOCUMENTATION & HELP

Files available:
  1. PONYOU-CLI-GUIDE.md       Main CLI documentation
  2. LLM-CUSTOM-SETUP.md        Custom LLM tools guide
  3. SETUP-PROVIDERS.md         LLM provider setup
  4. SETUP.md                   Initial setup guide
```

---

### **8. File Manager**

```
FILE MANAGER
━━━━━━━━━━━━

  1. user-config.json         (Main configuration)
  2. .env                     (Environment & secrets)
  3. lessons.json             (Learning data)
  4. state.json               (Agent state)
  5. performance.json         (Trade history)

Pilih file untuk dilihat (1-5)
```

View/edit JSON files directly dari CLI.

---

## 💻 COMMAND-LINE TOOLS

### **LLM CLI** - `llm-cli.js`

```bash
# List all providers
node llm-cli.js list
node llm-cli.js list groq

# Show current
node llm-cli.js current

# Switch provider
node llm-cli.js switch groq
node llm-cli.js switch anthropic

# Set API key
node llm-cli.js set-key groq gsk-xxxxxxxxxxxxx

# Validate configuration
node llm-cli.js validate

# Test provider connection
node llm-cli.js test groq

# Show provider info
node llm-cli.js info anthropic

# Show current .env LLM settings
node llm-cli.js show-env

# Help
node llm-cli.js help
```

### **LLM Manager** - `llm-manager.js`

Programmatic access untuk developer:

```javascript
import {
  setProvider,
  listProviders,
  getCurrentProvider,
  validateProvider,
  testProvider
} from './llm-manager.js';

// Examples
const all = listProviders();
setProvider('groq', 'gsk-xxxxx');
const current = getCurrentProvider();
```

### **Setup Wizard** - `setup-llm.js`

```bash
node setup-llm.js
```

Interactive menu untuk setup provider (guided experience).

---

## 📊 QUICK REFERENCE

### **Most Common Workflows:**

#### **1. First Time Setup (5 minutes)**
```bash
# Step 1: Main setup
node ponyou-launcher.js
→ Configuration → Setup Wizard

# Step 2: Test
→ Test System

# Step 3: Monitor
node ponyou-dashboard.js
```

#### **2. Switch LLM Provider**
```bash
# Fastest way
node llm-cli.js switch groq
node llm-cli.js set-key groq gsk-xxxxx

# Or interactive
node setup-llm.js
```

#### **3. Daily Monitoring**
```bash
# Quick status
node ponyou-dashboard.js

# Detailed analysis
node ponyou-monitor.js

# Full control
node ponyou-launcher.js
```

#### **4. Adjust Settings**
```bash
# Via menu
node ponyou-launcher.js
→ Configuration

# Or direct CLI
node ponyou-cli.js
→ Advanced Configuration
```

---

## 🔑 CONFIGURATION FILES

### **user-config.json** (Main config)
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
  "screeningIntervalMin": 30,
  "takeProfitPct": 5,
  "trailingStopEnabled": true
}
```

### **.env** (Secrets & API keys)
```bash
LLM_PROVIDER=groq
LLM_BASE_URL=https://api.groq.com/openai/v1
GROQ_API_KEY=gsk-xxxxxxxxxxxxx
RPC_URL=https://pump.helius-rpc.com
WALLET_PRIVATE_KEY=xxxxx
```

### **state.json** (Runtime state)
```json
{
  "positions": {
    "ABC": { "entry_amount": 12.50, "pnl": 3.06, ... },
    "XYZ": { "entry_amount": 8.75, "pnl": -0.72, ... }
  },
  "equity": 1182.50,
  "peakEquity": 1350,
  "lastUpdate": 1715787930000
}
```

### **performance.json** (Trade history)
```json
{
  "trades": [
    {
      "token": { "symbol": "ABC", "address": "..." },
      "entry_price": 0.25,
      "exit_price": 0.2625,
      "pnl_pct": 5.0,
      "win": true,
      "duration_seconds": 1200,
      "timestamp": 1715787800000
    }
  ]
}
```

### **lessons.json** (Learning data)
```json
{
  "lessons": [
    {
      "id": "lesson_001",
      "rule": "Skip tokens dengan fee > 1%",
      "times_applied": 45,
      "success_count": 38,
      "failure_count": 7,
      "win_rate": 84.4,
      "last_used": 1715787900000
    }
  ],
  "last_updated": 1715787930000
}
```

---

## ⚡ KEYBOARD SHORTCUTS

| Key | Action |
|-----|--------|
| `1-9` | Select menu option |
| `Enter` | Confirm |
| `q` | Quit/Back |
| `Ctrl+C` | Stop process |

---

## 🐛 TROUBLESHOOTING

### **"Cannot find module"**
```bash
# Make sure you're in Ponyou directory
cd /path/to/Ponyou-

# Run launcher
node ponyou-launcher.js
```

### **"LLM provider not responding"**
```bash
# Test connection
node llm-cli.js test groq

# Validate config
node llm-cli.js validate

# Check API key
node llm-cli.js show-env
```

### **"Agent won't start"**
```bash
# Run tests
node ponyou-launcher.js
→ Test System

# Check config
node ponyou-launcher.js
→ Monitor
```

### **"No open positions showing"**
```bash
# Check state file
node ponyou-launcher.js
→ File Manager
→ state.json

# Agent might be idle or starting
```

---

## 📚 RELATED DOCUMENTATION

- **PONYOU-CLI-GUIDE.md** - Original CLI guide
- **LLM-CUSTOM-SETUP.md** - Custom LLM tools
- **SETUP-PROVIDERS.md** - Provider details
- **SETUP.md** - Initial setup
- **.env.example** - Environment template

---

## 🚀 TYPICAL SESSION

### Morning (Start of day)

```bash
# 1. Check status
node ponyou-launcher.js
→ Monitor

# 2. Review performance
→ Monitor → see trading stats

# 3. Adjust if needed
→ Configuration → Advanced Config

# 4. Verify config
→ Test System
```

### During Day

```bash
# Monitor in background
node ponyou-dashboard.js

# Or detailed monitoring
node ponyou-monitor.js
```

### Evening (End of day)

```bash
# Comprehensive review
node ponyou-launcher.js
→ Monitor

# Check lessons learned
→ Monitor → Learning System

# Plan next day
→ Configuration if needed
```

---

## ✨ FEATURES SUMMARY

✅ **Single Entry Point** - ponyou-launcher.js  
✅ **Real-time Dashboard** - Auto-refresh 5s  
✅ **Comprehensive Monitor** - Detailed metrics  
✅ **Advanced Configuration** - All settings  
✅ **LLM Provider Management** - 9 providers  
✅ **File Manager** - View/manage configs  
✅ **Documentation** - Built-in help  
✅ **Test System** - Pre-flight validation  
✅ **Color-coded Output** - Easy to read  
✅ **Interactive Menus** - User-friendly  

---

## 🎯 QUICK COMMANDS

```bash
# Main launcher (everything)
node ponyou-launcher.js

# Quick dashboard
node ponyou-dashboard.js

# Detailed monitor
node ponyou-monitor.js

# Advanced config
node ponyou-cli.js

# Setup LLM
node setup-llm.js

# Quick provider commands
node llm-cli.js switch groq
node llm-cli.js validate
node llm-cli.js list
```

---

## 🎉 YOU'RE READY!

```bash
node ponyou-launcher.js
```

That's it! Full control of Ponyou from CLI. 🚀

Enjoy! 🐎
