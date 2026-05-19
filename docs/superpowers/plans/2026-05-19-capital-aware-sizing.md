# Capital-Aware Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ganti Kelly call di index.js dengan `getCapitalAwareSizing()` yang memilih strategi sizing berdasarkan tier modal — MICRO (<$50 flat regime), GROWTH ($50–$200 half-kelly + cap 20%), FULL (>$200 full Kelly).

**Architecture:** Satu file baru `capital-sizing.js` sebagai wrapper di atas `kelly.js`. `index.js` mengganti satu block import + call. `decision-log.js` menerima field baru tier/method/capped_at tanpa schema change (sudah flexible).

**Tech Stack:** Node.js ESM, vitest, `kelly.js` (existing), `config.js` (existing).

---

## File Map

| File | Aksi | Tanggung Jawab |
|------|------|----------------|
| `capital-sizing.js` | CREATE | Core tier logic — single source of truth untuk sizing |
| `tests/capital-sizing.test.js` | CREATE | Unit tests semua tier + boundary |
| `config.js` | MODIFY | Tambah `capitalSizing` defaults section |
| `index.js` | MODIFY | Ganti `computeFractionalKellySize` import + call block (1 lokasi) |

---

## Task 1: Tambah `capitalSizing` ke config.js

**Files:**
- Modify: `config.js` (setelah block `kelly:`, sekitar line 95)

- [ ] **Step 1: Buka config.js dan tambah capitalSizing block setelah block `kelly:`**

```js
// Di config.js, setelah block kelly: { ... },  tambah:

  capitalSizing: {
    microThreshold:          u.capitalSizingMicroThreshold  ?? 50,
    fullThreshold:           u.capitalSizingFullThreshold   ?? 200,
    microFlat: {
      HOT:  u.capitalSizingMicroHot      ?? 0.15,
      WARM: u.capitalSizingMicroWarm     ?? 0.08,
    },
    growthCap:               u.capitalSizingGrowthCap        ?? 0.20,
    growthFallbackFraction:  u.capitalSizingGrowthFallback   ?? 0.10,
  },
```

- [ ] **Step 2: Verifikasi config load tidak error**

```bash
node -e "import('./config.js').then(m => console.log(JSON.stringify(m.config.capitalSizing, null, 2)))"
```

Expected output:
```json
{
  "microThreshold": 50,
  "fullThreshold": 200,
  "microFlat": { "HOT": 0.15, "WARM": 0.08 },
  "growthCap": 0.2,
  "growthFallbackFraction": 0.1
}
```

- [ ] **Step 3: Commit**

```bash
git add config.js
git commit -m "feat: add capitalSizing config section — three-tier thresholds and flat fractions"
```

---

## Task 2: Buat tests/capital-sizing.test.js (failing dulu)

**Files:**
- Create: `tests/capital-sizing.test.js`

- [ ] **Step 1: Tulis test file**

```js
import { describe, expect, it } from "vitest";
import { getCapitalAwareSizing } from "../capital-sizing.js";

const DEFAULT_CFG = {
  microThreshold: 50,
  fullThreshold: 200,
  microFlat: { HOT: 0.15, WARM: 0.08 },
  growthCap: 0.20,
  growthFallbackFraction: 0.10,
};

// Helper: 6 modest trades — low payoff ratio, Kelly half will be under 20% cap
// winRate=0.5, avgWin=20%, avgLoss=15%, payoffRatio≈1.33 → Kelly≈0.124 → half≈0.031 → hits minFraction 0.1 → deploy=10% bankroll < 20% cap
const MODEST_TRADES = [
  { pnl_pct: 20 }, { pnl_pct: 20 }, { pnl_pct: 20 },
  { pnl_pct: -15 }, { pnl_pct: -15 }, { pnl_pct: -15 },
];

// Helper: 6 trades with extreme edge → Kelly will exceed 20% cap
const HIGH_EDGE_TRADES = [
  { pnl_pct: 60 }, { pnl_pct: 60 }, { pnl_pct: 60 },
  { pnl_pct: 60 }, { pnl_pct: 60 }, { pnl_pct: -5 },
];

describe("getCapitalAwareSizing — MICRO tier (capitalUsd < 50)", () => {
  it("returns flat 15% of bankroll for HOT regime", () => {
    // bankrollSol=0.15 * solPriceUsd=200 = capitalUsd=30 → MICRO
    const result = getCapitalAwareSizing({
      bankrollSol: 0.15,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("MICRO");
    expect(result.method).toBe("regime-flat");
    expect(result.skipped).toBe(false);
    expect(result.effective_fraction).toBeCloseTo(0.15);
    // deploy = min(0.15 * 0.15, 0.5) = 0.0225
    expect(result.deploy_amount_sol).toBeCloseTo(0.0225, 3);
    expect(result.capped_at).toBeNull();
  });

  it("returns flat 8% of bankroll for WARM regime", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.15,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "WARM",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("MICRO");
    expect(result.effective_fraction).toBeCloseTo(0.08);
    // deploy = min(0.15 * 0.08, 0.5) = 0.012
    expect(result.deploy_amount_sol).toBeCloseTo(0.012, 3);
    expect(result.skipped).toBe(false);
  });

  it("skips entry for DEAD regime", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.15,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "DEAD",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("MICRO");
    expect(result.skipped).toBe(true);
    expect(result.deploy_amount_sol).toBe(0);
  });

  it("skips entry for COLD regime", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.15,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "COLD",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.skipped).toBe(true);
    expect(result.deploy_amount_sol).toBe(0);
  });

  it("respects baseDeployAmountSol as upper cap", () => {
    // bankroll 0.5 SOL × 200 = $100 → wait, that's GROWTH
    // bankroll 0.1 SOL × 200 = $20 → MICRO
    // flatFraction HOT = 15% → 0.1 * 0.15 = 0.015
    // baseDeployAmountSol = 0.005 < 0.015 → respect base
    const result = getCapitalAwareSizing({
      bankrollSol: 0.1,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.005,
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.deploy_amount_sol).toBeCloseTo(0.005, 3);
  });

  it("boundary: capitalUsd=49.99 → MICRO", () => {
    // 0.2499 SOL × 200 = 49.98 → MICRO
    const result = getCapitalAwareSizing({
      bankrollSol: 0.2499,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("MICRO");
  });
});

describe("getCapitalAwareSizing — GROWTH tier ($50–$200)", () => {
  it("uses growth-fallback flat 10% when no trade history", () => {
    // bankrollSol=0.5 × solPriceUsd=200 = capitalUsd=100 → GROWTH
    const result = getCapitalAwareSizing({
      bankrollSol: 0.5,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: [],
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
    expect(result.method).toBe("growth-fallback");
    expect(result.used_fallback).toBe(true);
    // deploy = min(0.5 * 0.10, 0.5) = 0.05
    expect(result.deploy_amount_sol).toBeCloseTo(0.05, 3);
  });

  it("uses half-kelly and no cap when effective fraction < 20%", () => {
    // MODEST_TRADES: winRate=0.5, payoffRatio≈1.33 → low Kelly → stays under 20% cap
    const result = getCapitalAwareSizing({
      bankrollSol: 0.5,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: MODEST_TRADES,
      context: { marketCondition: "WARM", tokenEdgeScore: 50, holderStructureRisk: "LOW" },
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
    expect(result.method).toBe("half-kelly");
    expect(result.used_fallback).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.deploy_amount_sol).toBeGreaterThan(0);
    // Should be under 20% cap = 0.5 * 0.20 = 0.10
    expect(result.deploy_amount_sol).toBeLessThanOrEqual(0.10);
    expect(result.capped_at).toBeNull();
  });

  it("caps deploy at 20% of bankroll when half-kelly exceeds cap", () => {
    // HIGH_EDGE_TRADES → very high Kelly fraction → after halving still > 20%
    const result = getCapitalAwareSizing({
      bankrollSol: 0.5,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: HIGH_EDGE_TRADES,
      context: { marketCondition: "HOT", tokenEdgeScore: 80, holderStructureRisk: "LOW" },
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
    expect(result.method).toBe("half-kelly");
    // deploy capped at 20% of bankroll = 0.5 * 0.20 = 0.10
    expect(result.deploy_amount_sol).toBeCloseTo(0.10, 2);
    expect(result.capped_at).not.toBeNull();
  });

  it("boundary: capitalUsd=50 → GROWTH", () => {
    // 0.25 SOL × 200 = $50 → GROWTH
    const result = getCapitalAwareSizing({
      bankrollSol: 0.25,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.25,
      trades: [],
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
  });

  it("boundary: capitalUsd=199.99 → GROWTH", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.9999,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: [],
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("GROWTH");
  });
});

describe("getCapitalAwareSizing — FULL tier (>= $200)", () => {
  it("boundary: capitalUsd=200 → FULL", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 1.0,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: [],
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("FULL");
  });

  it("uses full-kelly with no extra cap", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 1.5,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      trades: MODEST_TRADES,
      context: { marketCondition: "WARM", tokenEdgeScore: 50, holderStructureRisk: "LOW" },
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.tier).toBe("FULL");
    expect(result.method).toBe("full-kelly");
    expect(result.capped_at).toBeNull();
    expect(result.deploy_amount_sol).toBeGreaterThan(0);
  });
});

describe("getCapitalAwareSizing — output shape", () => {
  it("always returns required fields", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.1,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.1,
      regime: "HOT",
      capitalSizing: DEFAULT_CFG,
    });
    expect(typeof result.deploy_amount_sol).toBe("number");
    expect(typeof result.kelly_fraction).toBe("number");
    expect(typeof result.effective_fraction).toBe("number");
    expect(typeof result.used_fallback).toBe("boolean");
    expect(typeof result.should_skip).toBe("boolean");
    expect(["MICRO", "GROWTH", "FULL"]).toContain(result.tier);
    expect(["regime-flat", "half-kelly", "full-kelly", "growth-fallback"]).toContain(result.method);
    expect(typeof result.capital_usd).toBe("number");
  });

  it("skipped result has deploy_amount_sol = 0 and should_skip = true", () => {
    const result = getCapitalAwareSizing({
      bankrollSol: 0.1,
      solPriceUsd: 200,
      baseDeployAmountSol: 0.5,
      regime: "DEAD",
      capitalSizing: DEFAULT_CFG,
    });
    expect(result.should_skip).toBe(true);
    expect(result.deploy_amount_sol).toBe(0);
  });
});
```

- [ ] **Step 2: Jalankan test untuk konfirmasi FAIL**

```bash
npx vitest run tests/capital-sizing.test.js
```

Expected: FAIL dengan `Cannot find module '../capital-sizing.js'`

---

## Task 3: Implementasi capital-sizing.js

**Files:**
- Create: `capital-sizing.js`

- [ ] **Step 1: Buat file capital-sizing.js**

```js
"use strict";

import { computeFractionalKellySize } from "./kelly.js";

const DEFAULT_CAPITAL_SIZING = {
  microThreshold: 50,
  fullThreshold: 200,
  microFlat: { HOT: 0.15, WARM: 0.08 },
  growthCap: 0.20,
  growthFallbackFraction: 0.10,
};

export function getCapitalAwareSizing({
  bankrollSol = 0,
  solPriceUsd = 0,
  baseDeployAmountSol = 0,
  trades = [],
  context = {},
  regime = "WARM",
  fraction = 0.5,
  minFraction = 0.1,
  maxFraction = 0.8,
  minSampleTrades = 5,
  capitalSizing = {},
} = {}) {
  const cfg = { ...DEFAULT_CAPITAL_SIZING, ...capitalSizing };
  const capitalUsd = (bankrollSol || 0) * (solPriceUsd || 0);

  // ── MICRO tier ──────────────────────────────────────────────────────────────
  if (capitalUsd < cfg.microThreshold) {
    const flatFraction = (cfg.microFlat || {})[regime] ?? null;
    if (!flatFraction) {
      return {
        deploy_amount_sol: 0,
        kelly_fraction: 0,
        effective_fraction: 0,
        inputs: {},
        used_fallback: true,
        should_skip: true,
        tier: "MICRO",
        method: "regime-flat",
        capital_usd: capitalUsd,
        capped_at: null,
      };
    }
    const deployAmount = Number(
      Math.min(bankrollSol * flatFraction, baseDeployAmountSol > 0 ? baseDeployAmountSol : Infinity).toFixed(4)
    );
    return {
      deploy_amount_sol: deployAmount,
      kelly_fraction: 0,
      effective_fraction: flatFraction,
      inputs: {},
      used_fallback: false,
      should_skip: false,
      tier: "MICRO",
      method: "regime-flat",
      capital_usd: capitalUsd,
      capped_at: null,
    };
  }

  const isGrowth = capitalUsd < cfg.fullThreshold;

  // ── GROWTH tier — no trade history fallback ─────────────────────────────────
  if (isGrowth && (trades || []).length < minSampleTrades) {
    const fallbackFraction = cfg.growthFallbackFraction;
    const fallbackAmount = Number(
      Math.min(bankrollSol * fallbackFraction, baseDeployAmountSol > 0 ? baseDeployAmountSol : Infinity).toFixed(4)
    );
    return {
      deploy_amount_sol: fallbackAmount,
      kelly_fraction: 0,
      effective_fraction: fallbackFraction,
      inputs: {},
      used_fallback: true,
      should_skip: false,
      tier: "GROWTH",
      method: "growth-fallback",
      capital_usd: capitalUsd,
      capped_at: null,
    };
  }

  // ── GROWTH tier — half-kelly with cap ───────────────────────────────────────
  // ── FULL tier — full kelly ──────────────────────────────────────────────────
  const kellyFraction = isGrowth ? fraction * 0.5 : fraction;
  const kelly = computeFractionalKellySize({
    bankrollSol,
    baseDeployAmountSol,
    trades,
    context,
    fraction: kellyFraction,
    minFraction,
    maxFraction,
    minSampleTrades,
  });

  if (!isGrowth) {
    return {
      ...kelly,
      tier: "FULL",
      method: "full-kelly",
      capital_usd: capitalUsd,
      capped_at: null,
    };
  }

  // GROWTH: apply cap
  const growthCapSol = bankrollSol * cfg.growthCap;
  const cappedAt = kelly.effective_fraction > cfg.growthCap ? kelly.effective_fraction : null;
  const finalAmount = Number(Math.min(kelly.deploy_amount_sol, growthCapSol).toFixed(4));
  return {
    ...kelly,
    deploy_amount_sol: finalAmount,
    tier: "GROWTH",
    method: "half-kelly",
    capital_usd: capitalUsd,
    capped_at: cappedAt,
  };
}
```

- [ ] **Step 2: Jalankan test untuk konfirmasi PASS**

```bash
npx vitest run tests/capital-sizing.test.js
```

Expected: semua tests PASS.

- [ ] **Step 3: Jalankan full test suite untuk pastikan tidak ada regresi**

```bash
npm test
```

Expected: 263+ tests passed (0 failed).

- [ ] **Step 4: Commit**

```bash
git add capital-sizing.js tests/capital-sizing.test.js
git commit -m "feat: capital-aware sizing — three-tier Kelly/regime-flat system"
```

---

## Task 4: Integrasi ke index.js

**Files:**
- Modify: `index.js` (2 lokasi: import line ~89, Kelly block ~1351–1373)

- [ ] **Step 1: Ganti import di index.js**

Cari baris (sekitar line 89):
```js
import { computeFractionalKellySize } from "./kelly.js";
```

Ganti dengan:
```js
import { getCapitalAwareSizing } from "./capital-sizing.js";
```

- [ ] **Step 2: Ganti Kelly call block di index.js**

Cari block (sekitar line 1351–1373):
```js
const kelly = config.kelly?.enabled
  ? computeFractionalKellySize({
      bankrollSol: balance.sol,
      baseDeployAmountSol: preKellyAmount,
      trades: recentTrades,
      context: {
        marketCondition: marketIntel.condition,
        tokenEdgeScore,
        holderStructureRisk: security?.holder_analysis?.holder_structure_risk || security?.rug_signals?.holder_structure_risk || "LOW",
      },
      fraction: config.kelly?.fraction ?? 0.5,
      minFraction: config.kelly?.minFraction ?? 0.1,
      maxFraction: config.kelly?.maxFraction ?? 0.8,
      minSampleTrades: config.kelly?.minSampleTrades ?? 5,
    })
  : {
      deploy_amount_sol: preKellyAmount,
      kelly_fraction: 0,
      effective_fraction: 0,
      inputs: {},
      used_fallback: true,
      should_skip: false,
    };
```

Ganti dengan:
```js
const kelly = config.kelly?.enabled
  ? getCapitalAwareSizing({
      bankrollSol: balance.sol,
      solPriceUsd: balance.sol_price || 0,
      baseDeployAmountSol: preKellyAmount,
      trades: recentTrades,
      context: {
        marketCondition: marketIntel.condition,
        tokenEdgeScore,
        holderStructureRisk: security?.holder_analysis?.holder_structure_risk || security?.rug_signals?.holder_structure_risk || "LOW",
      },
      regime: marketIntel.condition,
      fraction: config.kelly?.fraction ?? 0.5,
      minFraction: config.kelly?.minFraction ?? 0.1,
      maxFraction: config.kelly?.maxFraction ?? 0.8,
      minSampleTrades: config.kelly?.minSampleTrades ?? 5,
      capitalSizing: config.capitalSizing,
    })
  : {
      deploy_amount_sol: preKellyAmount,
      kelly_fraction: 0,
      effective_fraction: 0,
      inputs: {},
      used_fallback: true,
      should_skip: false,
      tier: "MICRO",
      method: "fallback",
      capital_usd: 0,
      capped_at: null,
    };
```

- [ ] **Step 3: Update flag message untuk should_skip di MICRO tier**

Cari (sekitar line 1420–1421):
```js
if (kelly.should_skip) {
  flags.push(`Kelly sizing rejected entry (edge=${kelly.kelly_fraction})`);
}
```

Ganti dengan:
```js
if (kelly.should_skip) {
  const skipReason = kelly.tier === "MICRO"
    ? `MICRO tier skip — regime ${marketIntel.condition} tidak kondusif untuk modal kecil`
    : `Kelly sizing rejected entry (edge=${kelly.kelly_fraction})`;
  flags.push(skipReason);
}
```

- [ ] **Step 4: Tambah tier + method ke recordDecision call**

Cari (sekitar line 1465–1474):
```js
recordDecision({
  type: "screening_candidate",
  mint: candidate.mint,
  symbol: candidate.symbol,
  passed: candidate.passed,
  verdict: candidate.workflow?.verdict || "active",
  caution_score: candidate.workflow?.caution_score ?? 0,
  conviction_score: candidate.conviction?.conviction_score ?? 0,
  regime_score: candidate.regime?.regime_score ?? 0,
});
```

Ganti dengan:
```js
recordDecision({
  type: "screening_candidate",
  mint: candidate.mint,
  symbol: candidate.symbol,
  passed: candidate.passed,
  verdict: candidate.workflow?.verdict || "active",
  caution_score: candidate.workflow?.caution_score ?? 0,
  conviction_score: candidate.conviction?.conviction_score ?? 0,
  regime_score: candidate.regime?.regime_score ?? 0,
  sizing_tier: candidate.kelly?.tier ?? null,
  sizing_method: candidate.kelly?.method ?? null,
  sizing_capital_usd: candidate.kelly?.capital_usd ?? null,
  sizing_capped_at: candidate.kelly?.capped_at ?? null,
});
```

- [ ] **Step 5: Jalankan full test suite**

```bash
npm test
```

Expected: semua tests PASS (tidak ada regresi).

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: integrate getCapitalAwareSizing into index.js — replace Kelly call"
```

---

## Task 5: Verifikasi akhir

- [ ] **Step 1: Jalankan full test suite sekali lagi**

```bash
npm test
```

Expected output:
```
Test Files  38 passed (38)
      Tests  290+ passed (290+)
```

- [ ] **Step 2: Smoke test config load**

```bash
node -e "
import('./config.js').then(m => {
  const cs = m.config.capitalSizing;
  console.log('microThreshold:', cs.microThreshold);
  console.log('fullThreshold:', cs.fullThreshold);
  console.log('microFlat:', JSON.stringify(cs.microFlat));
  console.log('growthCap:', cs.growthCap);
})"
```

Expected: semua nilai tampil tanpa error.

- [ ] **Step 3: Quick unit check capital-sizing**

```bash
node -e "
import('./capital-sizing.js').then(({ getCapitalAwareSizing }) => {
  const micro = getCapitalAwareSizing({ bankrollSol: 0.1, solPriceUsd: 200, baseDeployAmountSol: 0.5, regime: 'HOT' });
  console.log('MICRO HOT:', micro.tier, micro.method, micro.deploy_amount_sol);
  const dead = getCapitalAwareSizing({ bankrollSol: 0.1, solPriceUsd: 200, baseDeployAmountSol: 0.5, regime: 'DEAD' });
  console.log('MICRO DEAD skipped:', dead.should_skip);
  const growth = getCapitalAwareSizing({ bankrollSol: 0.5, solPriceUsd: 200, baseDeployAmountSol: 0.5, regime: 'HOT', trades: [] });
  console.log('GROWTH fallback:', growth.tier, growth.method, growth.deploy_amount_sol);
})"
```

Expected:
```
MICRO HOT: MICRO regime-flat 0.0225
MICRO DEAD skipped: true
GROWTH fallback: GROWTH growth-fallback 0.05
```

- [ ] **Step 4: Commit final jika ada perubahan tersisa**

```bash
git status
# Jika bersih, tidak perlu commit
# Jika ada perubahan, commit dengan message yang sesuai
```

---

## Ringkasan Perubahan

| File | Baris diubah | Perubahan |
|------|-------------|-----------|
| `config.js` | +8 baris | capitalSizing config section |
| `capital-sizing.js` | +85 baris | Core tier logic (NEW) |
| `tests/capital-sizing.test.js` | +170 baris | Unit tests (NEW) |
| `index.js` | ~20 baris diganti | Import + Kelly call + flag message + recordDecision |
