# ABC Testing & Monitoring Plan

## Executive Summary

ABC (Holder Dump Monitor + Entry Price Analysis + Rug Pattern Detector) is now **LIVE**:
- ✅ Integrated into cast-net-gate.js pre-entry checks
- ✅ Enabled in config.js with staged beta rollout (5%, 10%, 3%)
- ✅ Exit signals wired to index.js management cycle
- ⏳ **Now requires: backtest validation + live false-positive monitoring**

## Deployment Timeline

```
Week 1 (NOW):
  - Beta rollout: 5% of entry opportunities (dump monitor)
  - Monitor: false positives, missed detections
  - Target: <2% FP rate on entry screening

Week 2:
  - If FP rate <2%, expand to 10% (dump) + 10% (entry-price)
  - If FP rate >5%, disable and investigate

Week 3:
  - If stable at 10%, add pattern detector at 5%
  - Backtest suite must be ready by end of week

Week 4+:
  - Expand to 25% → 50% → 100% based on metrics
  - Maintain false-positive tracking indefinitely
```

## Testing Strategy

### 1. Backtest vs Known Rugs

**Goal**: Validate ABC detects 80%+ of historical rugpulls BEFORE -50% crash

**Test set** (samples):
```javascript
// Known rugs to backtest against (add historical examples from ponyou records)
const knownRugs = [
  {
    mint: "xxx...",
    symbol: "RUG1",
    entry_price: 0.00001,
    crash_price: 0.000001,
    crash_time: "2026-05-15T12:34:00Z",
    top_holder_dump_observed: true,
    pattern_type: "FLASH_DUMP"
  },
  // ... add 10-20 known rugs
];
```

**Backtest process**:
1. Load mint's historical snapshots/sells from ABC data files
2. Run ABC checks at 5-min intervals before the crash timestamp
3. Record: detection time, confidence, pattern_type
4. Calculate: lead time (how many minutes before -50% crash)
5. Aggregate: detection_rate, average_lead_time, false_positives

**Success criteria**:
- ✅ Detect ≥80% of rugs
- ✅ Average lead time ≥5 minutes before -50% crash
- ✅ Pattern type matches observation (FLASH_DUMP, LADDER, etc)
- ❌ FAIL if <70% detection rate or <2 min lead time

**Run this weekly via**:
```bash
npm run backtest:abc-rugs
```

### 2. False Positive Monitoring (Live)

**Goal**: Track % of ABC exit signals that were "wrong" (position recovered instead of crashing)

**Metrics to record** (in metrics.json):
```javascript
{
  "holder_exit_signals_total": 42,          // Total ABC exit signals fired
  "holder_exit_executed": 38,                // How many actually exited
  "holder_exit_recovered": 4,                // Exited but price recovered (FP)
  "holder_exit_avoided_loss": 31,            // Exited before >20% loss (TP)
  "holder_exit_slippage": 3,                 // Exited >20% loss (TP but late)
  
  "holder_exit_dump_critical": 8,
  "holder_exit_dump_high": 15,
  "holder_exit_underwater_critical": 5,
  "holder_exit_underwater_high": 6,
  "holder_exit_pattern_critical": 3,
  "holder_exit_pattern_high": 5,
  
  "false_positive_rate": 0.095,              // 4 / 42 = ~10%
  "avoided_loss_rate": 0.738,                // 31 / 42 = ~74%
  "true_positive_rate": 0.905                // 38 / 42 = ~91%
}
```

**Definition**:
- **True Positive**: ABC signal fired, position exited, price dropped ≥20% within 1 hour
- **False Positive**: ABC signal fired, position exited, price recovered (did NOT drop ≥20%)
- **Missed Signal**: No ABC signal, but price dropped ≥30% within 1 hour
- **Correct Soft Pass**: No ABC signal, price stable (did NOT drop ≥20%)

**Live tracking** (in index.js, whenever a position closes):
```javascript
// After position closes, log the outcome:
recordCounter("holder_exit_outcome_tp");    // TP
recordCounter("holder_exit_outcome_fp");    // FP
recordCounter("holder_exit_outcome_missed"); // Missed signal
recordCounter("holder_exit_outcome_safe");   // Correct soft pass
```

**Weekly review**:
```bash
# Display live metrics
npm run metrics:view | grep holder_exit

# Expected thresholds:
# false_positive_rate < 5%    (expand beta)
# false_positive_rate > 10%   (disable, investigate)
# true_positive_rate > 80%    (good detection)
```

### 3. Performance Impact Monitoring

**Goal**: ABC adds ~15-25 Helius calls per position per cycle. Track cost.

**Metrics**:
```javascript
{
  "helius_calls_per_cycle": 23,         // Total calls per 5-min cycle
  "helius_calls_cost_usd": 0.0046,      // @ $0.0002/call
  "helius_rate_limit_hits": 0,          // How many times we hit 100/sec
  "abc_processing_time_ms": 145,        // Total time for A+B+C checks
  "cache_hit_rate_snapshots": 0.82,     // Snapshot reuse efficiency
}
```

**Manage Helius cost**:
- If >50% of quota: reduce beta rollout % or increase cycle interval to 10 min
- If <10% of quota: can safely increase to 25% beta + faster cycle

### 4. Data Quality Checks

**Monthly validation** (first of month):
```bash
# 1. Check holder-snapshots.json is not bloated
du -sh holder-snapshots.json                 # Should be <100MB

# 2. Check entry-prices cache coherence
npm run validate:holder-entry-prices

# 3. Check pattern-detections not duplicating
npm run validate:rug-pattern-dedupe

# 4. Verify mint hash distribution (beta cohort fairness)
npm run validate:mint-hash-bucketing
```

## Alert Thresholds

### 🟢 Green (Healthy)
```
- False positive rate: 0-3%
- True positive rate: 85%+
- Missed signals: <5%
- Helius calls: <50% of quota
- Processing time: <200ms per position
```

### 🟡 Yellow (Caution)
```
- False positive rate: 5-8%
- True positive rate: 75-85%
- Missed signals: 5-10%
- Processing time: 200-500ms per position
→ Action: Increase confidence thresholds by +5-10%
```

### 🔴 Red (Disable)
```
- False positive rate: >10%
- True positive rate: <70%
- Missed signals: >15%
- Helius rate-limit hits: >2/day
→ Action: Disable ABC, investigate root cause
```

## Troubleshooting Guide

### Symptom: High False Positive Rate (>10%)

**Probable causes**:
1. **Zero-amount sells in pattern detector** → FIXED in commit 36e52c4
2. **Invalid timestamps** → FIXED in commit 36e52c4
3. **Empty addresses in holder analysis** → FIXED in commit 36e52c4
4. **Thresholds too aggressive** → Increase confidence_threshold in config

**Investigate**:
```bash
# Look at last 10 false-positive signals
tail -n 10 logs/holder_exit.log | grep "holder_analysis_error"

# Check if common pattern
grep "MEDIUM\|LOW" metrics.json | head -20
```

**Remediate**:
```javascript
// In config.js, increase thresholds:
{
  rugPatternDetector: {
    confidenceThreshold: 85  // was 70
  },
  dumpMonitor: {
    betaRolloutPct: 3        // was 5
  }
}
```

### Symptom: Missed Signals (Rugs happen, ABC didn't detect)

**Probable causes**:
1. **Token not in beta cohort** (bad luck with hash bucketing)
2. **Data unavailable** (Helius timeout, Birdeye down)
3. **Pattern doesn't match ABC signatures** (new rug type)

**Investigate**:
```bash
# Check if that mint was supposed to be checked
node -e "
const mint = 'xxx...';
const hash = [...mint].reduce((h,c) => ((h<<5)-h+c.charCodeAt(0))|0, 0);
const bucket = Math.abs(hash) % 100;
console.log('Bucket:', bucket, 'Cohort 5%? :', bucket < 5);
"

# Check if we have data for that mint
ls holder-snapshots.json | grep mint | head -5
jq '.mints | keys | length' holder-snapshots.json  # How many tracked?
```

**Remediate**:
- Increase beta rollout % (`betaRolloutPct: 10`)
- Add more data sources (ensure topHolders always available)
- Extend pattern signatures (add new rug type)

### Symptom: Helius Rate Limits Hit

**Probable causes**:
1. **Too many positions** (100+ open)
2. **ABC cycle too fast** (1 min, should be 5 min)
3. **Entry price analysis querying all holders** (expensive)

**Remediate**:
```javascript
// In config.js:
{
  dumpMonitor: {
    betaRolloutPct: 3        // Reduce cohort size
  },
  // OR increase the cycle interval in index.js from 5 min to 10 min
}
```

## Rollout Checklist

- [ ] **Week 1 Setup**
  - [ ] ABC enabled in config.js (5% beta dump monitor)
  - [ ] cast-net-gate.js pre-entry checks active
  - [ ] Metrics tracking wired (holder_exit_* counters)
  - [ ] False positive definitions documented
  - [ ] Daily log review process established

- [ ] **Week 2 Evaluation**
  - [ ] Backtest completed on 5+ known rugs
  - [ ] False positive rate <5% confirmed
  - [ ] Helius cost tracking in place
  - [ ] Expand to 10% beta (entry-price analysis)

- [ ] **Week 3 Integration**
  - [ ] Pattern detector added at 5% beta
  - [ ] Monthly validation scripts created
  - [ ] Alert thresholds configured
  - [ ] Troubleshooting runbook tested

- [ ] **Week 4+ Expansion**
  - [ ] All metrics stable at <5% FP rate
  - [ ] Expand to 25%
  - [ ] Then 50%
  - [ ] Then 100% (full rollout)

## Success = Ship

ABC is ready for full production when:
1. ✅ Backtest detection rate ≥80% on known rugs
2. ✅ False positive rate <2% on live trading
3. ✅ Average lead time ≥5 min before -50% crash
4. ✅ Helius cost <$10/day

**Target ship date**: 2026-06-12 (2 weeks from activation)
