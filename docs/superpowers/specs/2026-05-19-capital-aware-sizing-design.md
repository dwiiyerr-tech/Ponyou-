# Capital-Aware Sizing — Design Spec

**Date:** 2026-05-19  
**Status:** Approved  
**Author:** Claude (brainstorm session)

---

## Problem Statement

Bot Ponyou menggunakan Kelly fraction untuk menentukan ukuran posisi. Kelly membutuhkan data historis win/loss yang cukup untuk akurat. Dengan modal awal $10 dan tanpa trade history real, Kelly terlalu agresif dan bisa menghabiskan modal dalam beberapa trade. Di bawah $50, bot membutuhkan sizing yang konservatif dan regime-aware — bukan matematis-optimal.

## Success Criteria

- Modal < $50: sizing ditentukan oleh market regime (flat % of capital), bukan Kelly
- Modal $50–$200: Half-Kelly aktif dengan cap maksimal 20% modal
- Modal >= $200: Full Kelly aktif tanpa cap tambahan
- Semua threshold dan persentase bisa diubah via config tanpa edit kode
- Setiap sizing decision tercatat di decision log untuk audit
- Bot tidak pernah entry saat regime DEAD/COLD di tier Micro

## Architecture

```
agent.js (decision loop)
    │
    ▼
capital-sizing.js         ← NEW — single source of truth untuk sizing
    │
    ├── Tier: MICRO (<$50)
    │     └── regime-memory.js  → flat % of capital
    │
    ├── Tier: GROWTH ($50–$200)
    │     └── neural-risk.js    → half-kelly, capped 20%
    │
    └── Tier: FULL (>$200)
          └── neural-risk.js    → full kelly
```

### Interface

```js
// Input
getSizing({ capitalUsd, regime, winRate, avgWin, avgLoss })

// Output
{
  fraction,    // 0.0–1.0, porsi modal yang dipakai
  amountSol,   // jumlah SOL untuk entry
  tier,        // "MICRO" | "GROWTH" | "FULL"
  method,      // "regime-flat" | "half-kelly" | "full-kelly"
  cappedAt,    // fraction sebelum di-cap (null jika tidak di-cap)
  skipped,     // true jika regime DEAD/COLD di tier MICRO
}
```

## Tier Logic

### Tier MICRO (`capitalUsd < 50`)

| Regime | Fraction | Contoh ($20) |
|--------|----------|--------------|
| HOT    | 15%      | $3.00        |
| WARM   | 8%       | $1.60        |
| DEAD   | skip     | —            |
| COLD   | skip     | —            |

Tidak ada Kelly. Tidak ada data historis yang dibutuhkan. Regime dari `regime-memory.js`.

### Tier GROWTH (`50 <= capitalUsd < 200`)

- Gunakan `halfKelly` dari `neural-risk.js`
- Jika belum ada trade history (winRate = 0 atau data < 5 trades), fallback ke flat 10% modal
- Cap maksimal: 20% modal
- Jika `halfKelly > 0.20` → pakai 0.20, catat `cappedAt`
- Jika `halfKelly <= 0.20` → pakai `halfKelly` apa adanya

Contoh: modal $100, Kelly 30% → Half-Kelly 15% → tidak dicap → entry $15.  
Contoh: modal $100, Kelly 50% → Half-Kelly 25% → dicap 20% → entry $20.

### Tier FULL (`capitalUsd >= 200`)

- Gunakan `fraction` (full Kelly) dari `neural-risk.js`
- Tidak ada cap tambahan
- Tier ini hanya aktif setelah bot punya track record real dari tier Growth

## Configuration

Semua nilai disimpan di `config.js` dan bisa di-override via `user-config.json`:

```json
"capitalSizing": {
  "microThreshold": 50,
  "fullThreshold": 200,
  "microFlat": {
    "HOT": 0.15,
    "WARM": 0.08
  },
  "growthCap": 0.20
}
```

## Integration Points

### 1. `agent.js` — Entry Decision

Ganti panggilan Kelly langsung / `riskPerTrade` flat dengan:

```js
// capitalUsd dari trading-plan.js session.currentCapitalUsd atau wallet balance
// winRate/avgWin/avgLoss dari trading-plan.js session atau lessons history
const sizing = await getSizing({
  capitalUsd: currentCapitalUsd,
  regime: regimeMemory.current(),
  winRate, avgWin, avgLoss   // bisa 0/null jika belum ada history — ditangani di capital-sizing
})

if (sizing.skipped) {
  log('Sizing skipped — regime DEAD/COLD in MICRO tier')
  return
}

const amountSol = sizing.amountSol
```

### 2. `multi-wallet-allocation.js` — Multi-Wallet Split

Total allocation dari `capital-sizing.js` dulu, baru di-split ke wallet:

```
capital-sizing.js → total amountSol
      ↓
multi-wallet-allocation.js → split ke wallet A, B, C
```

### 3. `decision-log.js` — Audit Trail

Setiap sizing decision dicatat:

```
tier | method | capitalUsd | regime | fraction | amountSol | cappedAt | ts
```

## Files yang Diubah

| File | Perubahan |
|------|-----------|
| `capital-sizing.js` | **NEW** — core sizing logic |
| `config.js` | Tambah `capitalSizing` defaults |
| `agent.js` | Ganti Kelly call → `getSizing()` |
| `multi-wallet-allocation.js` | Terima total dari capital-sizing |
| `decision-log.js` | Tambah fields tier/method/cappedAt |
| `tests/capital-sizing.test.js` | **NEW** — unit + integration tests |

## Files yang TIDAK Diubah

- `kelly.js` — tetap as-is
- `neural-risk.js` — tetap as-is, dipanggil oleh capital-sizing
- `strategy.js` — exit rules tidak berkaitan
- `trading-plan.js` — compound tracking tetap jalan sendiri

## Testing

### Unit Tests (`tests/capital-sizing.test.js`)

```
✓ Modal $15, HOT  → tier MICRO, method regime-flat, fraction 0.15
✓ Modal $15, WARM → tier MICRO, fraction 0.08
✓ Modal $15, DEAD → skipped: true
✓ Modal $15, COLD → skipped: true
✓ Modal $80, Kelly 30% → tier GROWTH, capped at 0.20, cappedAt: 0.25
✓ Modal $80, Kelly 10% → tier GROWTH, fraction 0.05 (half-kelly), tidak dicap
✓ Modal $300, Kelly → tier FULL, full kelly, cappedAt: null
✓ Boundary $49.99 → MICRO, $50.00 → GROWTH
✓ Config override: microThreshold diubah → tier ikut berubah
```

### Integration Tests

```
✓ agent.js tidak entry saat sizing.skipped = true
✓ multi-wallet: total dari capital-sizing, split dari allocation
✓ decision-log mencatat tier dan method di setiap entry
```

### Manual Dry-Run Checklist (sebelum go-live)

1. Set `capitalUsd` ke $20 di config, jalankan dry-run → verify sizing ~$3 (HOT)
2. Set `capitalUsd` ke $100 → verify Half-Kelly aktif, cap 20% bekerja
3. Paksa regime DEAD → verify bot skip semua entry, tidak ada swap dikirim

## Scope Summary

**1 file baru:** `capital-sizing.js`  
**1 test file baru:** `tests/capital-sizing.test.js`  
**Edit ringan:** `config.js`, `agent.js`, `multi-wallet-allocation.js`, `decision-log.js`
