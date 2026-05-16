# Ponyou CLI Setup Wizard

Interactive terminal setup untuk konfigurasi lengkap Ponyou trading agent.

## Quick Start

```bash
# Launcher tercepat
./configure

# Atau via npm
npm run setup

# Atau langsung Node
node setup.js
```

## Features

Setup wizard menyediakan 3 mode:

### 1. Full Setup (Wizard Interaktif)
Konfigurasi semua aspek Ponyou dengan panduan step-by-step:

- **Wallet & RPC** — private key, RPC endpoint
- **LLM Provider** — OpenRouter atau LM Studio local
- **Pilot Mode** — compound trading plan 30 hari
- **Vault** — auto savings ke wallet lain
- **Daily Reports** — scheduling laporan otomatis
- **Risk Limits** — max positions, max deploy
- **Screening** — pool selection criteria (TVL, volume, holders, mcap, dll)
- **Position Management** — stop loss, take profit, trailing, rebalancing
- **Strategy** — trading strategy selection
- **Scheduling** — intervals untuk management/screening/health checks
- **LLM Settings** — temperature, max tokens, steps
- **Darwin Weighting** — signal weight evolution
- **Indicators** — chart indicator presets
- **Telegram Notifications** — optional alerts
- **HiveMind** — agent meridian integration
- **Advanced** — dry run, cooldowns, launchpad filters, SOL mode

### 2. Quick Setup
Hanya essentials: wallet, RPC, LLM, pilot, dan risk limits.

### 3. View Current Config
Tampilkan konfigurasi user-config.json yang sedang aktif.

### 4. Reset Config
Hapus user-config.json dan mulai dari nol.

## Config Files

Setup wizard mengatur dua file:

### `user-config.json`
File konfigurasi utama Ponyou dalam format JSON.
- Semua setting termasuk wallet, RPC, LLM, trading parameters
- Prioritas lebih tinggi dari .env
- Mudah di-edit manual jika diperlukan

### `.env`
Environment variables untuk secrets dan API keys.
- WALLET_PRIVATE_KEY, RPC_URL
- OPENROUTER_API_KEY atau LLM_BASE_URL + LLM_API_KEY
- HELIUS_API_KEY, GMGN_ROUTE_KEY
- TELEGRAM credentials (opsional)
- VAULT_WALLET

## Usage Workflow

### Pertama kali
```bash
./configure
# Pilih "1. Full Setup (wizard interaktif)"
# Isi semua section sesuai kebutuhan
# File .env dan user-config.json otomatis tersimpan
```

### Ubah setting tertentu
```bash
./configure
# Pilih "1. Full Setup" dan ikuti wizard
# Hanya perlu isi yang ingin diubah, sisanya pakai default
```

### Lihat config sekarang
```bash
./configure
# Pilih "3. View Current Config"
```

### Reset semuanya
```bash
./configure
# Pilih "4. Reset Config"
# Kemudian "1. Full Setup" untuk setup baru
```

## Edit Manual

Kedua file bisa diedit langsung dengan text editor:

```bash
# Edit user-config.json langsung
nano user-config.json

# Edit .env
nano .env
```

Setelah edit manual, restart agent untuk apply changes (atau `reloadScreeningThresholds()` untuk threshold saja).

## LLM Provider Selection

### Option A: OpenRouter (Default - Cloud)
- API-based, tidak perlu server lokal
- Supports minimax, GPT, Claude, dll
- Butuh OPENROUTER_API_KEY
- Setup: pilih "OpenRouter (default)" di wizard

### Option B: LM Studio (Local)
- Menjalankan model lokal di mesin
- Setup: pilih "LM Studio (local)" di wizard
- Default URL: `http://localhost:1234/v1`
- Butuh LM Studio running di background

## Pilot Mode (Compound Trading)

Strategi compound trading 30 hari dengan target profit dan session pause:

```json
{
  "pilotEnabled": true,
  "pilotCapitalUsd": 10,        // Modal awal
  "dailyTargetPct": 25,         // Target profit % per hari
  "dailyStopLossPct": -10,      // Stop loss % per hari
  "sessionPauseDurationMin": 60, // Pause ketika target/loss tercapai
  "planDays": 30                // Durasi plan (hari)
}
```

Agent akan pause ketika:
- Daily profit >= 25% → pause 60 menit
- Daily loss <= -10% → pause 60 menit

## Vault (Auto Savings)

Transfer otomatis % profit ke wallet savings:

```json
{
  "vaultWallet": "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
  "vaultPct": 35,      // Transfer 35% profit
  "vaultIntervalDays": 7 // Setiap 7 hari
}
```

## Risk Management

```json
{
  "maxPositions": 3,        // Max 3 posisi terbuka
  "maxDeployAmount": 50,    // Max $50 per trade
  "stopLossPct": -50,       // Close jika -50%
  "takeProfitPct": 5,       // Target exit di +5%
  "trailingTakeProfit": true,
  "trailingTriggerPct": 3,  // Trigger trailing di +3%
  "trailingDropPct": 1.5    // Close jika drop 1.5% dari peak
}
```

## Multi-Strategy Presets (v4)

Ponyou v4 mengusung 5 preset strategy bawaan, masing-masing dengan filter gate, ROI table, stop-loss, trailing, dan partial-TP berbeda:

| Preset | Use case |
|--------|----------|
| `scalping` | Default — Freqtrade-style ROI di pair baru |
| `sniper` | Strict fees + low-mcap window, hard stops |
| `dip_buy` | Tunggu dip -40% dari ATH di token yang lebih matang |
| `smart_money` | High mcap, partial TP 50% @ +100% lalu runner |
| `degen` | Filter longgar, stop ketat, **tanpa LLM** (rule-based) |

**Switching strategy** (hot, tanpa restart):
```
/strategy sniper          # via Telegram
```

**Override per-field** (mis. ganti stop-loss sniper jadi -20%):
```
/stratset sniper stoploss -0.20
```

Active preset disimpan di `active-strategy.json`, overrides di `strategies-overrides.json` — keduanya hot-readable.

## Confirm Mode (v4 — Human-in-the-loop)

Aktifkan untuk supervisi setiap BUY sebelum eksekusi:

```json
{
  "confirmMode": true,
  "confirmTtlMin": 5
}
```

Atau via env:
```bash
CONFIRM_MODE=true npm start
```

**Cara kerjanya:**
1. LLM atau strategy memutuskan BUY token X
2. Sebelum gmgn_swap eksekusi, intent diparkir di `pending-intents.json`
3. Telegram menerima notifikasi: `🟡 Pending BUY #3 — 0.1 SOL → XXX111. /yes 3 atau /no 3`
4. User reply `/yes 3` → executor.js panggil gmgnSwap, trackPosition jalan, intent ditandai executed
5. Bila TTL habis (default 5 min) atau user `/no 3` → intent ditolak, tidak ada swap

Toggle runtime tanpa restart: `/confirm on` atau `/confirm off`.

## Pool Screening Criteria

```json
{
  "minTvl": 10000,          // Min $10k TVL
  "maxTvl": 150000,         // Max $150k TVL
  "minVolume": 500,         // Min $500 volume
  "minHolders": 500,        // Min 500 holders
  "minMcap": 150000,        // Min $150k market cap
  "maxMcap": 10000000,      // Max $10M market cap
  "minOrganic": 60,         // Min 60% organic
  "maxBotHoldersPct": 30,   // Max 30% bot holders
  "maxTop10Pct": 60         // Max 60% top 10 concentration
}
```

## Tips

- **Dry Run** — Set `dryRun: true` untuk test tanpa real trading
- **Start Small** — Mulai dengan `pilotCapitalUsd: 10` atau `deployAmountSol: 0.1`
- **Monitor** — Lihat daily report dan trading-plan.json untuk track progress
- **Iterate** — Update config untuk adapt ke market conditions
- **Backup** — Simpan copy user-config.json sebelum major changes

## Troubleshooting

**Error: Cannot read user-config.json**
- File belum ada atau corrupt. Jalankan wizard dan buat fresh config.

**Error: Module not found**
- Jalankan `npm install` terlebih dahulu

**API Key tidak terdeteksi**
- Pastikan .env file ada dan format benar
- Pastikan tidak ada space sebelum/sesudah `=`

**LM Studio connection error**
- Pastikan LM Studio running dan listening di `http://localhost:1234/v1`
- Check URL di user-config.json
