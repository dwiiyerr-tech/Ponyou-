# Holder Analysis Improvements (ABC) Integration Guide

## Overview

Three complementary improvements to holder analysis for rug detection and exit signals:

- **A) Holder Dump Monitor** (`holder-dump-monitor.js`) — Real-time tracking of top holder balance changes
- **B) Entry Price Analysis** (`holder-entry-price.js`) — Detect underwater holders = sell pressure
- **C) Rug Pattern Detector** (`rug-pattern-detector.js`) — Identify coordinated multi-wallet rug patterns

## Integration Points

### 1. Exit Monitor Integration

**File**: `exit-monitor.js` (or equivalent)

**Hook into** management cycle (runs every 1-10 min per position):

```javascript
import { monitorHolderDumps, recordHolderSnapshot } from "./tools/holder-dump-monitor.js";
import { analyzeHolderEntryPrices } from "./tools/holder-entry-price.js";
import { detectRugPattern } from "./tools/rug-pattern-detector.js";

async function checkHolderHealth(position) {
  const { mint, currentPrice } = position;
  
  // A: Record snapshot + detect dumps
  await recordHolderSnapshot({
    tokenMint: mint,
    topHolders: position.topHolders, // from data source
    totalSupply: position.totalSupply
  });
  
  const dumpRisk = monitorHolderDumps({
    tokenMint: mint,
    currentTopHolders: position.topHolders,
    lookbackMinutes: 60
  });
  
  if (dumpRisk.risk_level === "CRITICAL") {
    triggerExitSignal(position, "HOLDER_DUMP_DETECTED", dumpRisk);
    return;
  }
  
  // B: Analyze entry prices
  const entryAnalysis = analyzeHolderEntryPrices({
    tokenMint: mint,
    currentPriceUsd: currentPrice,
    holderTransactions: position.holderTxHistory // from Helius
  });
  
  if (entryAnalysis.underwater_pct >= 80 && entryAnalysis.confidence > 70) {
    triggerExitSignal(position, "MASSIVE_UNDERWATER", entryAnalysis);
    return;
  }
  
  // C: Detect coordinated patterns
  const patternRisk = detectRugPattern({
    tokenMint: mint,
    recentSells: position.recentSells, // from transaction history
    windowMinutes: 5
  });
  
  if (patternRisk.pattern_detected && patternRisk.rug_risk === "CRITICAL") {
    triggerExitSignal(position, "RUG_PATTERN_DETECTED", patternRisk);
  }
}
```

### 2. Cast-Net Gate Enhancement

**File**: `tools/cast-net-gate.js`

**Add pre-entry checks**:

```javascript
function evaluateCastNet(token) {
  // Existing checks: market, liquidity, narrative...
  
  // NEW: Add holder analysis pre-checks
  const holderDumpRisk = monitorHolderDumps({
    tokenMint: token.mint,
    currentTopHolders: token.topHolders,
    lookbackMinutes: 30 // recent activity only
  });
  
  if (holderDumpRisk.risk_level === "HIGH" || holderDumpRisk.risk_level === "CRITICAL") {
    return { ok: false, reason: `holders: dump risk ${holderDumpRisk.risk_level}` };
  }
  
  const patternRisk = detectRugPattern({
    tokenMint: token.mint,
    recentSells: token.recentSells || []
  });
  
  if (patternRisk.pattern_detected && patternRisk.confidence > 60) {
    return { ok: false, reason: `holders: ${patternRisk.pattern_type} pattern detected` };
  }
  
  return { ok: true, reason: "holders: healthy distribution" };
}
```

### 3. Data Sources

Tools expect data from existing Ponyou sources:

#### A) Dump Monitor needs:
- `topHolders`: array of `{ address, balance, pct }`
- Source: Birdeye, DexScreener, or Helius

#### B) Entry Price Analysis needs:
- `holderTransactions`: array of `{ address, txs: [{ amount, priceUsd, timestamp }] }`
- Source: Helius `getTransactionHistory()` or similar
- Fallback: `priceHistory` for timestamp-based estimation

#### C) Pattern Detector needs:
- `recentSells`: array of `{ address, amountUsd, timestamp, txSignature }`
- Source: Recent token transfers from Helius or blockchain

### 4. Data Refresh Cycle

**Recommended frequencies**:

| Tool | Data | Frequency | Cost |
|------|------|-----------|------|
| A (Dump Monitor) | topHolders snapshot | 5-10 min per position | ~2 Helius calls |
| B (Entry Prices) | holderTransactions | 30-60 min (or on entry) | ~5-10 Helius calls per holder |
| C (Pattern Detect) | recentSells | 1-2 min (catch dumps early) | ~3-5 Helius calls |

**Total**: ~10-20 Helius calls per active position per cycle
**Strategy**: Run A+C on fast cycle (1-5 min), B on slower cycle (30 min)

### 5. Feature Flags

Recommend rolling out gradually:

```javascript
// config.js
export const config = {
  holderAnalysis: {
    dumpMonitor: {
      enabled: false,  // Start beta at 5% of positions
      betaRolloutPct: 5,
      riskThreshold: "HIGH"
    },
    entryPriceAnalysis: {
      enabled: false,  // Beta at 10% first
      betaRolloutPct: 10,
      underwaterThreshold: 80
    },
    rugPatternDetector: {
      enabled: false,  // Most aggressive, start at 3%
      betaRolloutPct: 3,
      confidenceThreshold: 70
    }
  }
};
```

### 6. Logging & Telemetry

All three tools log to standard logger:

```javascript
log("holder_monitor", `Position ${mint}: dump risk ${risk_level}`);
log("holder_entry", `Position ${mint}: ${underwater_pct.toFixed(0)}% underwater`);
log("rug_pattern", `Pattern detected: ${pattern_type} on ${mint}`);
```

Add metrics for monitoring:

```
metric: holder.dump.signals_per_cycle
metric: holder.entry.underwater_positions
metric: holder.pattern.rugs_detected_per_day
metric: holder.false_positives (monitor false exit signals)
```

### 7. Exit Signal Format

All three tools return structured exit signals:

```javascript
{
  reason: "HOLDER_DUMP_DETECTED" | "MASSIVE_UNDERWATER" | "RUG_PATTERN_DETECTED",
  risk_level: "CRITICAL" | "HIGH" | "MEDIUM",
  confidence: 0-100,
  details: { ... },
  recommendation: "IMMEDIATE_EXIT" | "WATCH_CLOSELY"
}
```

**Exit trigger logic**:
- CRITICAL + confidence > 70 = IMMEDIATE exit (within 30sec)
- HIGH + confidence > 80 = Scheduled exit (within 5 min)
- MEDIUM + confidence > 60 = Alert + watch (exit if worsens)

### 8. Testing Plan

**Unit tests** (`tests/holder-abc.test.js`):
- Record and retrieve holder snapshots
- Detect known rug patterns (pump-and-dump signature)
- Estimate entry prices from historical data
- Validate pattern matching false positive rate (<5%)

**Integration tests**:
- Live Helius data on trending tokens
- Backtest against historical rugs (expect 80%+ detection)
- Measure false positive rate on real positions

**Beta deployment**:
- 5% of open positions with dump monitor
- 10% with entry price analysis
- 3% with pattern detection
- Monitor false exits for 1 week, then expand

## Files

```
tools/holder-dump-monitor.js    (835 lines) — A) Dump detection + snapshots
tools/holder-entry-price.js     (392 lines) — B) Entry price analysis
tools/rug-pattern-detector.js   (398 lines) — C) Pattern detection
```

Data files (auto-created):
```
holder-snapshots.json           — A) Historical snapshots per mint
holder-entry-prices.json        — B) Cached entry price analyses
rug-patterns.json               — C) Pattern detections log
```

## Next Steps

1. ✅ Create tools (ABC completed)
2. → Integrate into exit-monitor.js
3. → Add feature flags to config.js
4. → Wire to cast-net-gate.js
5. → Create integration tests
6. → Beta rollout on 5% of positions
7. → Monitor metrics for 1 week
8. → Expand to 25% → 100% based on FP rate
