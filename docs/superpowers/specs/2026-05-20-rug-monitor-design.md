# Rug Monitor — Post-Entry Real-Time Risk Detection

**Status:** Draft (spec) | **Date:** 2026-05-20 | **Sub-project:** B of upgrade roadmap (B→A→C→D→E)

## Problem

Ponyou's existing rug protection runs only at screening time. Once a position is open, signals are cached for up to 1 hour and there is no continuous re-scoring. A deployer can pass screening and rug 5–30 minutes later with zero protection from the bot. Codex strategy review identified this as a CRITICAL_GAP capable of causing >30% session loss in realistic scenarios.

## Goal

Detect rug-in-progress on OPEN positions and auto-exit before liquidity disappears, using real-time on-chain signals.

## Non-goals

- Pre-entry screening (already handled by `tools/rug-signals.js`)
- Price-drop detection (already handled by `geyser-exit-monitor.js`)
- ML / anomaly detection — pure rule-based thresholds
- Cross-position correlation (e.g., "3 positions sharing deployer = exit all")
- Social signals (Telegram chatter, Twitter)
- Frontrunning / MEV protection — that is sub-project A

## Architecture

**New module:** `rug-monitor.js` (target ~250 LOC).
**New helper:** `tools/entry-metadata.js` for capturing `{ deployer, lp_address, top_holders, authorities }` at entry time.

**Boundary:**

| Module | Purpose | Touched? |
|---|---|---|
| `rug-monitor.js` | Per-position rug state machine + signal coordination | NEW |
| `tools/entry-metadata.js` | Capture entry-time metadata | NEW |
| `rug-signals.js` | Pre-entry screening | unchanged |
| `geyser-exit-monitor.js` | Price-drop monitor | unchanged |
| `geyser.js` | Generic Geyser client | unchanged |
| `index.js` | Wire `rug-monitor` into lifecycle | edits |

**Public API:**

```js
export function createRugMonitor({ geyserStream, config, callbacks })
// Instance:
//   .attachPosition(positionKey, metadata)
//   .detachPosition(positionKey)
//   .getMonitoredPositions()
//   .shutdown()
```

## Data Flow

```
Entry success (executePendingIntent)
  → captureEntryMetadata(mint)        // deployer, lp, top10, authorities
  → rugMonitor.attachPosition(key, meta)
    → subscribe Geyser to deployer token account, lp account, mint account
    → schedule polling fallback every 30s

Geyser event OR polling tick
  → run 4 signal detectors with current state
  → severity engine aggregates: position-level severity = max(per-detector)
  → dedupe: emit only if severity > last_emitted for that detector
  → callback(severity, signal_type, position_key, meta)

Exit (recordClose)
  → rugMonitor.detachPosition(key)
    → unsubscribe Geyser, clear polling timer, clean state

SIGTERM
  → rugMonitor.shutdown() → detach all
```

## Per-Position State

```js
{
  meta: {
    mint, position_key,
    deployer_wallet,
    lp_address,
    top_holders_snapshot,        // [{wallet, balance}] x 10
    authorities,                 // { mint_authority, freeze_authority }
    entry_ts,
  },
  geyser_subs: [...subIds],
  polling_handle,
  last_check_ts: { dev_sell, lp, authority, holders },
  last_severity_emitted: { dev_sell, lp, authority, holders },
  shutdown: false,
}
```

## Signal Detectors

### 1. Dev/Creator Sell
- **Watch:** deployer SPL token account for the position mint
- **Geyser source:** account update on deployer's token account
- **Polling source:** Helius `getTokenAccountsByOwner(deployer, mint)`
- **Logic:** `delta = (current_balance − balance_at_entry) / balance_at_entry`, where `balance_at_entry` is a one-time snapshot at `attachPosition` time. Subsequent inbound transfers do not raise the baseline — only outbound (sell) movements count.
- **Severity:**
  - `delta ≤ −5%` and `> −20%` → LOW
  - `delta ≤ −20%` and `> −50%` → MEDIUM
  - `delta ≤ −50%` → HIGH

### 2. LP Movement / Burn / Remove
- **Watch:** pool LP token account + LP token mint
- **Geyser source:** transaction logs involving pool address
- **Polling source:** Helius `getAccountInfo(lp_address)` + DexScreener `liquidityUsd` comparison
- **Logic:** detect (a) LP transfer to non-program wallet, (b) LP burn (transfer to known incinerator address `1nc1nerator11111111111111111111111111111111`), (c) liquidity-removal instructions on Raydium v4 (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`), Raydium CLMM, or Meteora pools. Pump.fun bonding-curve tokens (pre-migration) are tracked via their bonding curve account; migration to Raydium re-anchors LP address.
- **Severity:**
  - LP transfer to known burn address → none (locked, safe)
  - `< 20%` LP removed → LOW
  - `20–50%` removed → MEDIUM
  - `> 50%` removed → HIGH
  - `removeLiquidity` instruction by `deployer_wallet` → instant HIGH

### 3. Authority Change (mint / freeze)
- **Watch:** mint account for the position mint
- **Geyser source:** account update on mint
- **Polling source:** Helius `getAccountInfo(mint)`
- **Logic:** compare current `mint_authority` / `freeze_authority` to snapshot at entry
- **Severity:**
  - mint authority `null → any` → HIGH (rug setup)
  - freeze authority `null → any` → HIGH (freeze attack)
  - either authority transferred to known burn → LOW (good news, but log)

### 4. Top Holder Dump
- **Watch:** top 10 holders captured at entry
- **Geyser source:** account updates on each tracked top-holder token account
- **Polling source:** Helius `getTokenLargestAccounts(mint)`
- **Logic:** sum balance delta across all 10 in a rolling 5-minute window (sliding, recomputed on each event), as % of original top-10 combined supply
- **Severity:**
  - `≤ −10%` and `> −25%` → LOW
  - `≤ −25%` and `> −50%` → MEDIUM
  - `≤ −50%` → HIGH

## Severity Engine

**Position-level severity** = `max(per_detector_severity)`. Multiple MEDIUMs do not compound to HIGH.

**Dedup rule:** Each detector tracks `last_severity_emitted`. Emit only when new severity is strictly higher than last for that detector. No downgrade emission.

**Rate limit:** LOW notifications capped at 1 per position per 60s. MEDIUM/HIGH always pass (urgency override).

## Action Mapping

| Severity | Action | Rationale |
|---|---|---|
| LOW | notify + subtract 2 percentage points from `trailingTriggerPct` (floored at 1) | Mild warning; tighten exits without panic-sell |
| MEDIUM | notify + `sellPartial(0.5)` via Jupiter | Halve exposure; survive false positives, capture remaining if benign |
| HIGH | notify + `sellAll()` immediately + tag position `rug_exit` | Capital preservation > opportunity cost |

Sell action retry: 3x with escalating priority fee (1.5x, 2x, 3x). If all retries fail → emit `monitor_exit_failed` HIGH alert; manual intervention required.

## Integration Points in index.js

1. **Startup wiring** (after Geyser stream init in `startTurboButtons`):
   ```js
   rugMonitor = createRugMonitor({
     geyserStream: _geyserStream,
     config: config.rugMonitor,
     callbacks: { onLow, onMedium, onHigh },
   });
   ```
2. **On entry success** (in `executePendingIntent` after swap confirmed):
   ```js
   const entryMeta = await captureEntryMetadata(mint);
   rugMonitor.attachPosition(positionKey, entryMeta);
   ```
3. **On exit** (after `recordClose`):
   ```js
   rugMonitor.detachPosition(positionKey);
   ```
4. **Shutdown handler** (SIGTERM):
   ```js
   rugMonitor.shutdown();
   ```

## Error Handling

| Scenario | Behavior |
|---|---|
| Geyser disconnect mid-position | Polling activates within 30s. Log `[RUG_MONITOR] Geyser dropped, polling active` |
| Helius circuit open + Shyft missing | Polling returns degraded; emit MEDIUM `data_unavailable` once per 5min |
| `captureEntryMetadata` returns partial | Attach with whatever was captured; detectors with missing data skip silently |
| Sell action fails 3x | Emit `monitor_exit_failed` HIGH alert; require manual intervention |
| `attachPosition` for already-tracked key | Idempotent: refresh metadata, do not double-subscribe |
| `detachPosition` for unknown key | No-op + warning log |
| Geyser event for already-detached position | Drop silently (race guard) |
| Top holder snapshot fails | Detector 4 disabled for this position; others continue |

## Telegram Notification Format

```
[RUG_MONITOR] HIGH on {symbol}
Signal: dev_sell (deployer sold 67% of holdings)
Source: geyser
Action: sellAll() triggered
Position: {position_key}
PnL at exit: +12.3%
```

LOW / MEDIUM / HIGH use distinct emoji prefixes for fast Telegram scanning.

## Testing

**Unit tests** (`tests/rug-monitor.test.js`):
- Each detector emits correct severity for synthetic events
- Severity dedup: same severity does not re-emit
- Severity escalation: LOW then MEDIUM → both emit
- No downgrade: HIGH then LOW after → LOW not emitted
- Polling fallback activates when Geyser flag false
- `attachPosition` idempotent
- `detachPosition` cleans state + unsubscribes
- Partial metadata: attaches with subset of detectors

**Integration test** (`tests/rug-monitor-integration.test.js`):
- Mock Geyser + mock callbacks
- Attach → emit dev-sell event → callback fires with correct severity
- Simulate Geyser disconnect → polling takes over → event source = "polling"
- 3 concurrent positions, signal on 1 does not affect others

**Coverage target:** ≥85% for `rug-monitor.js` + `tools/entry-metadata.js`.

## Configuration

```json
{
  "rugMonitor": {
    "enabled": true,
    "pollingIntervalSec": 30,
    "rateLimitLowSec": 60,
    "devSellThresholds":      { "low": -5,  "medium": -20, "high": -50 },
    "lpMovementThresholds":   { "low": -20, "medium": -50, "high": null },
    "holderDumpThresholds":   { "low": -10, "medium": -25, "high": -50 },
    "actions": {
      "low":    { "type": "tighten_trail", "params": { "trailingDeltaPct": -2 } },
      "medium": { "type": "sell_partial",  "params": { "fraction": 0.5 } },
      "high":   { "type": "sell_all" }
    }
  }
}
```

## Success Criteria

- Detect rug-in-progress within 5s of on-chain signal (Geyser path) or 30s (polling fallback)
- Auto-exit triggered on HIGH severity without operator intervention
- No false-positive HIGH on legitimate price action (validated via 30+ historical positions in backtest replay)
- Unit + integration tests ≥85% coverage, all passing
- Zero impact on existing pre-entry screening latency
