# Rug Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time post-entry rug detection that auto-exits OPEN positions when on-chain rug signals fire, closing the largest remaining CRITICAL_GAP from strategy review.

**Architecture:** New module `rug-monitor.js` with per-position state machine, 4 pure-function signal detectors (dev sell, LP movement, authority change, top holder dump), severity engine (LOW/MEDIUM/HIGH with dedup + no-downgrade), Geyser primary + 30s polling fallback. Wired into `index.js` at startup/entry/exit/shutdown.

**Tech Stack:** Node.js ESM, vitest for tests, existing Helius/Shyft/DexScreener clients, existing Geyser client (`geyser.js`), existing Jupiter swap path.

**File map:**
- CREATE: `rug-monitor.js` — main module, public API + state machine + severity engine
- CREATE: `tools/entry-metadata.js` — `captureEntryMetadata(mint)` helper
- CREATE: `tests/rug-monitor.test.js` — unit tests for detectors + severity + lifecycle
- CREATE: `tests/entry-metadata.test.js` — unit tests for metadata capture
- CREATE: `tests/rug-monitor-integration.test.js` — full mock-Geyser integration test
- MODIFY: `config.js` — parse `config.rugMonitor` block with defaults
- MODIFY: `user-config.json` — add `rugMonitor` config block
- MODIFY: `index.js` — wire startup/attach/detach/shutdown

---

## Task 1: Config schema + defaults

**Files:**
- Modify: `config.js` (add rugMonitor parsing)
- Modify: `user-config.json` (add rugMonitor block)
- Test: `tests/rug-monitor-config.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/rug-monitor-config.test.js`:
```js
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("rugMonitor config", () => {
  it("provides safe defaults when block is missing", () => {
    const cfg = loadConfig({ raw: {} });
    expect(cfg.rugMonitor).toBeDefined();
    expect(cfg.rugMonitor.enabled).toBe(true);
    expect(cfg.rugMonitor.pollingIntervalSec).toBe(30);
    expect(cfg.rugMonitor.devSellThresholds).toEqual({ low: -5, medium: -20, high: -50 });
    expect(cfg.rugMonitor.lpMovementThresholds).toEqual({ low: -20, medium: -50, high: null });
    expect(cfg.rugMonitor.holderDumpThresholds).toEqual({ low: -10, medium: -25, high: -50 });
    expect(cfg.rugMonitor.actions.high).toEqual({ type: "sell_all" });
  });

  it("respects user overrides", () => {
    const cfg = loadConfig({ raw: { rugMonitor: { enabled: false, pollingIntervalSec: 15 } } });
    expect(cfg.rugMonitor.enabled).toBe(false);
    expect(cfg.rugMonitor.pollingIntervalSec).toBe(15);
    expect(cfg.rugMonitor.devSellThresholds).toEqual({ low: -5, medium: -20, high: -50 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rug-monitor-config.test.js`
Expected: FAIL with `cfg.rugMonitor is undefined`.

- [ ] **Step 3: Add config parsing in `config.js`**

Find the section where other config blocks are normalized (search for `u.management` pattern). Add this block:

```js
const rugMonitor = {
  enabled: u.rugMonitor?.enabled ?? true,
  pollingIntervalSec: Number.isFinite(u.rugMonitor?.pollingIntervalSec) ? u.rugMonitor.pollingIntervalSec : 30,
  rateLimitLowSec: Number.isFinite(u.rugMonitor?.rateLimitLowSec) ? u.rugMonitor.rateLimitLowSec : 60,
  devSellThresholds: {
    low: u.rugMonitor?.devSellThresholds?.low ?? -5,
    medium: u.rugMonitor?.devSellThresholds?.medium ?? -20,
    high: u.rugMonitor?.devSellThresholds?.high ?? -50,
  },
  lpMovementThresholds: {
    low: u.rugMonitor?.lpMovementThresholds?.low ?? -20,
    medium: u.rugMonitor?.lpMovementThresholds?.medium ?? -50,
    high: u.rugMonitor?.lpMovementThresholds?.high ?? null,
  },
  holderDumpThresholds: {
    low: u.rugMonitor?.holderDumpThresholds?.low ?? -10,
    medium: u.rugMonitor?.holderDumpThresholds?.medium ?? -25,
    high: u.rugMonitor?.holderDumpThresholds?.high ?? -50,
  },
  actions: {
    low: u.rugMonitor?.actions?.low ?? { type: "tighten_trail", params: { trailingDeltaPct: -2 } },
    medium: u.rugMonitor?.actions?.medium ?? { type: "sell_partial", params: { fraction: 0.5 } },
    high: u.rugMonitor?.actions?.high ?? { type: "sell_all" },
  },
};
```

Add `rugMonitor` to the returned config object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rug-monitor-config.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Add rugMonitor block to `user-config.json`**

Append to the JSON object (preserve existing keys):
```json
"rugMonitor": {
  "enabled": true,
  "pollingIntervalSec": 30,
  "rateLimitLowSec": 60,
  "devSellThresholds": { "low": -5, "medium": -20, "high": -50 },
  "lpMovementThresholds": { "low": -20, "medium": -50, "high": null },
  "holderDumpThresholds": { "low": -10, "medium": -25, "high": -50 },
  "actions": {
    "low": { "type": "tighten_trail", "params": { "trailingDeltaPct": -2 } },
    "medium": { "type": "sell_partial", "params": { "fraction": 0.5 } },
    "high": { "type": "sell_all" }
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add config.js user-config.json tests/rug-monitor-config.test.js
git commit -m "feat(rug-monitor): config schema + defaults"
```

---

## Task 2: Severity engine (pure functions)

**Files:**
- Create: `rug-monitor.js` (initial skeleton with SEVERITY + aggregateSeverity + shouldEmit)
- Test: `tests/rug-monitor.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/rug-monitor.test.js`:
```js
import { describe, expect, it } from "vitest";
import { SEVERITY, aggregateSeverity, shouldEmit } from "../rug-monitor.js";

describe("severity engine", () => {
  it("aggregates per-detector severity by max", () => {
    expect(aggregateSeverity({ a: SEVERITY.LOW, b: SEVERITY.HIGH })).toBe(SEVERITY.HIGH);
    expect(aggregateSeverity({ a: SEVERITY.NONE, b: SEVERITY.NONE })).toBe(SEVERITY.NONE);
    expect(aggregateSeverity({})).toBe(SEVERITY.NONE);
  });

  it("emits only on strict upgrade, never downgrade", () => {
    expect(shouldEmit(SEVERITY.MEDIUM, SEVERITY.LOW)).toBe(true);
    expect(shouldEmit(SEVERITY.HIGH, SEVERITY.MEDIUM)).toBe(true);
    expect(shouldEmit(SEVERITY.MEDIUM, SEVERITY.MEDIUM)).toBe(false);
    expect(shouldEmit(SEVERITY.LOW, SEVERITY.HIGH)).toBe(false);
    expect(shouldEmit(SEVERITY.NONE, SEVERITY.LOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: FAIL with `Cannot find module ../rug-monitor.js`.

- [ ] **Step 3: Create `rug-monitor.js` skeleton**

```js
export const SEVERITY = Object.freeze({
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
});

export function aggregateSeverity(perDetector) {
  const values = Object.values(perDetector || {});
  if (values.length === 0) return SEVERITY.NONE;
  return Math.max(SEVERITY.NONE, ...values);
}

export function shouldEmit(newSev, lastSev) {
  return newSev > lastSev;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: PASS (2 tests in "severity engine").

- [ ] **Step 5: Commit**

```bash
git add rug-monitor.js tests/rug-monitor.test.js
git commit -m "feat(rug-monitor): severity engine (aggregate + shouldEmit)"
```

---

## Task 3: Detector — Dev/Creator Sell

**Files:**
- Modify: `rug-monitor.js` (add `detectDevSell`)
- Modify: `tests/rug-monitor.test.js` (add tests)

- [ ] **Step 1: Append failing tests to `tests/rug-monitor.test.js`**

```js
import { detectDevSell } from "../rug-monitor.js";

describe("detectDevSell", () => {
  const thresholds = { low: -5, medium: -20, high: -50 };

  it("returns NONE when delta is positive or zero", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 1100, thresholds })).toBe(SEVERITY.NONE);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 1000, thresholds })).toBe(SEVERITY.NONE);
  });

  it("returns LOW for 5–20% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 940, thresholds })).toBe(SEVERITY.LOW);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 810, thresholds })).toBe(SEVERITY.LOW);
  });

  it("returns MEDIUM for 20–50% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 790, thresholds })).toBe(SEVERITY.MEDIUM);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 510, thresholds })).toBe(SEVERITY.MEDIUM);
  });

  it("returns HIGH for >=50% drop", () => {
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 500, thresholds })).toBe(SEVERITY.HIGH);
    expect(detectDevSell({ balanceAtEntry: 1000, currentBalance: 0, thresholds })).toBe(SEVERITY.HIGH);
  });

  it("returns NONE for invalid entry balance", () => {
    expect(detectDevSell({ balanceAtEntry: 0, currentBalance: 100, thresholds })).toBe(SEVERITY.NONE);
    expect(detectDevSell({ balanceAtEntry: null, currentBalance: 100, thresholds })).toBe(SEVERITY.NONE);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: FAIL with `detectDevSell is not exported`.

- [ ] **Step 3: Add `detectDevSell` to `rug-monitor.js`**

```js
export function detectDevSell({ balanceAtEntry, currentBalance, thresholds }) {
  if (!Number.isFinite(balanceAtEntry) || balanceAtEntry <= 0) return SEVERITY.NONE;
  if (!Number.isFinite(currentBalance)) return SEVERITY.NONE;
  const deltaPct = ((currentBalance - balanceAtEntry) / balanceAtEntry) * 100;
  if (deltaPct >= 0) return SEVERITY.NONE;
  if (thresholds.high !== null && deltaPct <= thresholds.high) return SEVERITY.HIGH;
  if (thresholds.medium !== null && deltaPct <= thresholds.medium) return SEVERITY.MEDIUM;
  if (thresholds.low !== null && deltaPct <= thresholds.low) return SEVERITY.LOW;
  return SEVERITY.NONE;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: PASS (severity engine 2 + detectDevSell 5 = 7 tests).

- [ ] **Step 5: Commit**

```bash
git add rug-monitor.js tests/rug-monitor.test.js
git commit -m "feat(rug-monitor): dev sell detector"
```

---

## Task 4: Detector — LP Movement / Burn / Remove

**Files:**
- Modify: `rug-monitor.js` (add `detectLpMovement` + constants)
- Modify: `tests/rug-monitor.test.js`

- [ ] **Step 1: Append failing tests**

```js
import { detectLpMovement, BURN_ADDRESSES, LP_PROGRAMS } from "../rug-monitor.js";

describe("detectLpMovement", () => {
  const thresholds = { low: -20, medium: -50, high: null };
  const deployer = "Dep111111111111111111111111111111111111111";

  it("returns NONE when LP unchanged", () => {
    expect(detectLpMovement({
      lpAtEntry: 100000,
      currentLp: 100000,
      thresholds,
    })).toBe(SEVERITY.NONE);
  });

  it("returns LOW for 5–20% LP drop", () => {
    expect(detectLpMovement({
      lpAtEntry: 100000,
      currentLp: 85000,
      thresholds,
    })).toBe(SEVERITY.NONE);
    expect(detectLpMovement({
      lpAtEntry: 100000,
      currentLp: 79000,
      thresholds,
    })).toBe(SEVERITY.LOW);
  });

  it("returns MEDIUM for 20–50% drop", () => {
    expect(detectLpMovement({
      lpAtEntry: 100000,
      currentLp: 60000,
      thresholds,
    })).toBe(SEVERITY.MEDIUM);
  });

  it("returns HIGH for >50% drop", () => {
    expect(detectLpMovement({
      lpAtEntry: 100000,
      currentLp: 40000,
      thresholds,
    })).toBe(SEVERITY.HIGH);
  });

  it("returns NONE when LP transfer goes to a known burn address", () => {
    expect(detectLpMovement({
      lpAtEntry: 100000,
      currentLp: 0,
      transferTo: "1nc1nerator11111111111111111111111111111111",
      thresholds,
    })).toBe(SEVERITY.NONE);
  });

  it("returns HIGH on removeLiquidity by deployer regardless of % drop", () => {
    expect(detectLpMovement({
      lpAtEntry: 100000,
      currentLp: 95000,
      removeLiquidityBy: deployer,
      deployerWallet: deployer,
      thresholds,
    })).toBe(SEVERITY.HIGH);
  });

  it("exposes burn addresses + LP programs constants", () => {
    expect(BURN_ADDRESSES).toContain("1nc1nerator11111111111111111111111111111111");
    expect(LP_PROGRAMS.raydiumV4).toBe("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: FAIL with `detectLpMovement is not exported`.

- [ ] **Step 3: Add to `rug-monitor.js`**

```js
export const BURN_ADDRESSES = Object.freeze([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);

export const LP_PROGRAMS = Object.freeze({
  raydiumV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  raydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  meteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
});

export function detectLpMovement({
  lpAtEntry,
  currentLp,
  transferTo = null,
  removeLiquidityBy = null,
  deployerWallet = null,
  thresholds,
}) {
  if (removeLiquidityBy && deployerWallet && removeLiquidityBy === deployerWallet) {
    return SEVERITY.HIGH;
  }
  if (transferTo && BURN_ADDRESSES.includes(transferTo)) {
    return SEVERITY.NONE;
  }
  if (!Number.isFinite(lpAtEntry) || lpAtEntry <= 0) return SEVERITY.NONE;
  if (!Number.isFinite(currentLp)) return SEVERITY.NONE;
  const deltaPct = ((currentLp - lpAtEntry) / lpAtEntry) * 100;
  if (deltaPct >= 0) return SEVERITY.NONE;
  if (thresholds.high !== null && deltaPct <= thresholds.high) return SEVERITY.HIGH;
  if (thresholds.medium !== null && deltaPct <= thresholds.medium) return SEVERITY.MEDIUM;
  if (thresholds.low !== null && deltaPct <= thresholds.low) return SEVERITY.LOW;
  return SEVERITY.NONE;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: PASS (7 + 7 = 14 tests).

- [ ] **Step 5: Commit**

```bash
git add rug-monitor.js tests/rug-monitor.test.js
git commit -m "feat(rug-monitor): LP movement detector + burn/program constants"
```

---

## Task 5: Detector — Authority Change

**Files:**
- Modify: `rug-monitor.js` (add `detectAuthorityChange`)
- Modify: `tests/rug-monitor.test.js`

- [ ] **Step 1: Append failing tests**

```js
import { detectAuthorityChange } from "../rug-monitor.js";

describe("detectAuthorityChange", () => {
  it("returns NONE when both authorities unchanged", () => {
    expect(detectAuthorityChange({
      atEntry: { mint_authority: null, freeze_authority: null },
      current: { mint_authority: null, freeze_authority: null },
    })).toBe(SEVERITY.NONE);
  });

  it("returns HIGH when mint authority changes from null to address", () => {
    expect(detectAuthorityChange({
      atEntry: { mint_authority: null, freeze_authority: null },
      current: { mint_authority: "Auth111111111111111111111111111111111111111", freeze_authority: null },
    })).toBe(SEVERITY.HIGH);
  });

  it("returns HIGH when freeze authority changes from null to address", () => {
    expect(detectAuthorityChange({
      atEntry: { mint_authority: null, freeze_authority: null },
      current: { mint_authority: null, freeze_authority: "Auth222222222222222222222222222222222222222" },
    })).toBe(SEVERITY.HIGH);
  });

  it("returns LOW when authority transferred to burn address (good news but log)", () => {
    expect(detectAuthorityChange({
      atEntry: { mint_authority: "Auth1111111111111111111111111111111111111111", freeze_authority: null },
      current: { mint_authority: "1nc1nerator11111111111111111111111111111111", freeze_authority: null },
    })).toBe(SEVERITY.LOW);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: FAIL with `detectAuthorityChange is not exported`.

- [ ] **Step 3: Add to `rug-monitor.js`**

```js
export function detectAuthorityChange({ atEntry, current }) {
  const entryMint = atEntry?.mint_authority ?? null;
  const currMint = current?.mint_authority ?? null;
  const entryFreeze = atEntry?.freeze_authority ?? null;
  const currFreeze = current?.freeze_authority ?? null;

  const becameSet = (a, b) => a === null && b !== null;
  const transferredToBurn = (a, b) => a !== null && b !== null && a !== b && BURN_ADDRESSES.includes(b);

  if (becameSet(entryMint, currMint) && !BURN_ADDRESSES.includes(currMint)) return SEVERITY.HIGH;
  if (becameSet(entryFreeze, currFreeze) && !BURN_ADDRESSES.includes(currFreeze)) return SEVERITY.HIGH;
  if (transferredToBurn(entryMint, currMint) || transferredToBurn(entryFreeze, currFreeze)) return SEVERITY.LOW;
  return SEVERITY.NONE;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: PASS (14 + 4 = 18 tests).

- [ ] **Step 5: Commit**

```bash
git add rug-monitor.js tests/rug-monitor.test.js
git commit -m "feat(rug-monitor): authority change detector"
```

---

## Task 6: Detector — Top Holder Dump (rolling window)

**Files:**
- Modify: `rug-monitor.js` (add `detectHolderDump`)
- Modify: `tests/rug-monitor.test.js`

- [ ] **Step 1: Append failing tests**

```js
import { detectHolderDump } from "../rug-monitor.js";

describe("detectHolderDump", () => {
  const thresholds = { low: -10, medium: -25, high: -50 };
  const now = 1_700_000_000_000;
  const ago = (ms) => now - ms;

  it("returns NONE when no recent events", () => {
    expect(detectHolderDump({
      snapshotTotal: 10_000_000,
      events: [],
      windowMs: 5 * 60_000,
      nowMs: now,
      thresholds,
    })).toBe(SEVERITY.NONE);
  });

  it("ignores events older than the window", () => {
    expect(detectHolderDump({
      snapshotTotal: 10_000_000,
      events: [{ tsMs: ago(10 * 60_000), deltaTokens: -3_000_000 }],
      windowMs: 5 * 60_000,
      nowMs: now,
      thresholds,
    })).toBe(SEVERITY.NONE);
  });

  it("returns LOW for ~10–25% cumulative dump within window", () => {
    expect(detectHolderDump({
      snapshotTotal: 10_000_000,
      events: [
        { tsMs: ago(60_000), deltaTokens: -700_000 },
        { tsMs: ago(30_000), deltaTokens: -600_000 },
      ],
      windowMs: 5 * 60_000,
      nowMs: now,
      thresholds,
    })).toBe(SEVERITY.LOW);
  });

  it("returns MEDIUM for ~25–50% dump", () => {
    expect(detectHolderDump({
      snapshotTotal: 10_000_000,
      events: [{ tsMs: ago(30_000), deltaTokens: -3_500_000 }],
      windowMs: 5 * 60_000,
      nowMs: now,
      thresholds,
    })).toBe(SEVERITY.MEDIUM);
  });

  it("returns HIGH for >=50% dump", () => {
    expect(detectHolderDump({
      snapshotTotal: 10_000_000,
      events: [{ tsMs: ago(30_000), deltaTokens: -6_000_000 }],
      windowMs: 5 * 60_000,
      nowMs: now,
      thresholds,
    })).toBe(SEVERITY.HIGH);
  });

  it("ignores inbound (positive) deltas", () => {
    expect(detectHolderDump({
      snapshotTotal: 10_000_000,
      events: [
        { tsMs: ago(60_000), deltaTokens: 5_000_000 },
        { tsMs: ago(30_000), deltaTokens: -1_500_000 },
      ],
      windowMs: 5 * 60_000,
      nowMs: now,
      thresholds,
    })).toBe(SEVERITY.LOW);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: FAIL with `detectHolderDump is not exported`.

- [ ] **Step 3: Add to `rug-monitor.js`**

```js
export function detectHolderDump({ snapshotTotal, events, windowMs, nowMs, thresholds }) {
  if (!Number.isFinite(snapshotTotal) || snapshotTotal <= 0) return SEVERITY.NONE;
  const cutoff = nowMs - windowMs;
  const cumulativeSold = (events || [])
    .filter(e => e.tsMs >= cutoff && Number.isFinite(e.deltaTokens) && e.deltaTokens < 0)
    .reduce((sum, e) => sum + e.deltaTokens, 0);
  if (cumulativeSold === 0) return SEVERITY.NONE;
  const deltaPct = (cumulativeSold / snapshotTotal) * 100;
  if (thresholds.high !== null && deltaPct <= thresholds.high) return SEVERITY.HIGH;
  if (thresholds.medium !== null && deltaPct <= thresholds.medium) return SEVERITY.MEDIUM;
  if (thresholds.low !== null && deltaPct <= thresholds.low) return SEVERITY.LOW;
  return SEVERITY.NONE;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: PASS (18 + 6 = 24 tests).

- [ ] **Step 5: Commit**

```bash
git add rug-monitor.js tests/rug-monitor.test.js
git commit -m "feat(rug-monitor): holder dump detector with rolling window"
```

---

## Task 7: Entry metadata capture helper

**Files:**
- Create: `tools/entry-metadata.js`
- Test: `tests/entry-metadata.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entry-metadata.test.js`:
```js
import { describe, expect, it, vi } from "vitest";
import { captureEntryMetadata } from "../tools/entry-metadata.js";

describe("captureEntryMetadata", () => {
  it("returns full metadata when all sources succeed", async () => {
    const fetchers = {
      getMintInfo: vi.fn().mockResolvedValue({
        creator: "Dep111111111111111111111111111111111111111",
        mint_authority: null,
        freeze_authority: null,
      }),
      getPoolInfo: vi.fn().mockResolvedValue({ pool_address: "Pool1111111111111111111111111111111111111111", lp_usd: 25000 }),
      getTopHolders: vi.fn().mockResolvedValue([
        { wallet: "W1", balance: 1000 },
        { wallet: "W2", balance: 500 },
      ]),
    };
    const meta = await captureEntryMetadata("MINT", fetchers);
    expect(meta.deployer_wallet).toBe("Dep111111111111111111111111111111111111111");
    expect(meta.lp_address).toBe("Pool1111111111111111111111111111111111111111");
    expect(meta.lp_usd_at_entry).toBe(25000);
    expect(meta.top_holders_snapshot).toHaveLength(2);
    expect(meta.authorities).toEqual({ mint_authority: null, freeze_authority: null });
    expect(meta.partial).toBe(false);
  });

  it("marks partial=true when one fetcher fails", async () => {
    const fetchers = {
      getMintInfo: vi.fn().mockResolvedValue({ creator: "Dep", mint_authority: null, freeze_authority: null }),
      getPoolInfo: vi.fn().mockRejectedValue(new Error("pool not found")),
      getTopHolders: vi.fn().mockResolvedValue([]),
    };
    const meta = await captureEntryMetadata("MINT", fetchers);
    expect(meta.lp_address).toBeNull();
    expect(meta.partial).toBe(true);
    expect(meta.errors).toContain("pool_info_failed");
  });

  it("returns mint-only metadata if all fetchers fail", async () => {
    const fetchers = {
      getMintInfo: vi.fn().mockRejectedValue(new Error("rpc down")),
      getPoolInfo: vi.fn().mockRejectedValue(new Error("rpc down")),
      getTopHolders: vi.fn().mockRejectedValue(new Error("rpc down")),
    };
    const meta = await captureEntryMetadata("MINT", fetchers);
    expect(meta.mint).toBe("MINT");
    expect(meta.partial).toBe(true);
    expect(meta.errors).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/entry-metadata.test.js`
Expected: FAIL with `Cannot find module ../tools/entry-metadata.js`.

- [ ] **Step 3: Create `tools/entry-metadata.js`**

```js
export async function captureEntryMetadata(mint, fetchers) {
  const errors = [];
  let mintInfo = null;
  let poolInfo = null;
  let topHolders = [];

  try { mintInfo = await fetchers.getMintInfo(mint); }
  catch (e) { errors.push("mint_info_failed"); }

  try { poolInfo = await fetchers.getPoolInfo(mint); }
  catch (e) { errors.push("pool_info_failed"); }

  try { topHolders = await fetchers.getTopHolders(mint); }
  catch (e) { errors.push("top_holders_failed"); }

  return {
    mint,
    deployer_wallet: mintInfo?.creator ?? null,
    lp_address: poolInfo?.pool_address ?? null,
    lp_usd_at_entry: poolInfo?.lp_usd ?? null,
    top_holders_snapshot: Array.isArray(topHolders) ? topHolders : [],
    authorities: {
      mint_authority: mintInfo?.mint_authority ?? null,
      freeze_authority: mintInfo?.freeze_authority ?? null,
    },
    partial: errors.length > 0,
    errors,
    entry_ts: Date.now(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/entry-metadata.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/entry-metadata.js tests/entry-metadata.test.js
git commit -m "feat(rug-monitor): captureEntryMetadata helper with partial fallback"
```

---

## Task 8: State machine — `createRugMonitor` with attach/detach/shutdown

**Files:**
- Modify: `rug-monitor.js` (add `createRugMonitor`)
- Modify: `tests/rug-monitor.test.js`

- [ ] **Step 1: Append failing tests**

```js
import { createRugMonitor } from "../rug-monitor.js";

describe("createRugMonitor lifecycle", () => {
  const makeStubs = () => ({
    geyserStream: { subscribe: vi.fn().mockReturnValue("subid"), unsubscribe: vi.fn() },
    config: {
      enabled: true,
      pollingIntervalSec: 30,
      devSellThresholds: { low: -5, medium: -20, high: -50 },
      lpMovementThresholds: { low: -20, medium: -50, high: null },
      holderDumpThresholds: { low: -10, medium: -25, high: -50 },
      actions: { low: { type: "tighten_trail" }, medium: { type: "sell_partial" }, high: { type: "sell_all" } },
    },
    callbacks: { onLow: vi.fn(), onMedium: vi.fn(), onHigh: vi.fn() },
    fetchers: { getMintAccount: vi.fn(), getTokenBalance: vi.fn(), getLargestAccounts: vi.fn(), getPoolLiquidityUsd: vi.fn() },
  });

  it("attachPosition stores metadata and is idempotent", () => {
    const s = makeStubs();
    const rm = createRugMonitor(s);
    const meta = { mint: "M", deployer_wallet: "D", lp_address: "L", top_holders_snapshot: [], authorities: { mint_authority: null, freeze_authority: null }, entry_ts: 1 };
    rm.attachPosition("M::W", meta);
    rm.attachPosition("M::W", meta);
    expect(rm.getMonitoredPositions()).toHaveLength(1);
  });

  it("detachPosition removes state", () => {
    const s = makeStubs();
    const rm = createRugMonitor(s);
    rm.attachPosition("M::W", { mint: "M", deployer_wallet: "D", lp_address: "L", top_holders_snapshot: [], authorities: {}, entry_ts: 1 });
    rm.detachPosition("M::W");
    expect(rm.getMonitoredPositions()).toHaveLength(0);
  });

  it("detachPosition for unknown key is a no-op", () => {
    const s = makeStubs();
    const rm = createRugMonitor(s);
    expect(() => rm.detachPosition("X::Y")).not.toThrow();
  });

  it("shutdown detaches all positions", () => {
    const s = makeStubs();
    const rm = createRugMonitor(s);
    rm.attachPosition("M1::W", { mint: "M1", deployer_wallet: "D", lp_address: "L", top_holders_snapshot: [], authorities: {}, entry_ts: 1 });
    rm.attachPosition("M2::W", { mint: "M2", deployer_wallet: "D", lp_address: "L", top_holders_snapshot: [], authorities: {}, entry_ts: 1 });
    rm.shutdown();
    expect(rm.getMonitoredPositions()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: FAIL with `createRugMonitor is not exported`.

- [ ] **Step 3: Add `createRugMonitor` to `rug-monitor.js`**

```js
export function createRugMonitor({ geyserStream, config, callbacks, fetchers, log = console.log }) {
  const positions = new Map(); // positionKey -> state
  let shuttingDown = false;

  function _newState(meta) {
    return {
      meta,
      geyser_subs: [],
      polling_handle: null,
      holder_events: [],
      last_severity_emitted: { dev_sell: SEVERITY.NONE, lp: SEVERITY.NONE, authority: SEVERITY.NONE, holders: SEVERITY.NONE },
      shutdown: false,
    };
  }

  function attachPosition(positionKey, meta) {
    if (shuttingDown) return;
    if (positions.has(positionKey)) {
      // idempotent: refresh meta only
      positions.get(positionKey).meta = { ...positions.get(positionKey).meta, ...meta };
      return;
    }
    positions.set(positionKey, _newState(meta));
  }

  function detachPosition(positionKey) {
    const state = positions.get(positionKey);
    if (!state) return;
    if (state.polling_handle) clearTimeout(state.polling_handle);
    for (const sub of state.geyser_subs) {
      try { geyserStream?.unsubscribe?.(sub); } catch (_) {}
    }
    state.shutdown = true;
    positions.delete(positionKey);
  }

  function getMonitoredPositions() {
    return Array.from(positions.keys()).map(k => ({ position_key: k, meta: positions.get(k).meta }));
  }

  function shutdown() {
    shuttingDown = true;
    for (const key of Array.from(positions.keys())) {
      detachPosition(key);
    }
  }

  return { attachPosition, detachPosition, getMonitoredPositions, shutdown };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: PASS (24 + 4 = 28 tests).

- [ ] **Step 5: Commit**

```bash
git add rug-monitor.js tests/rug-monitor.test.js
git commit -m "feat(rug-monitor): createRugMonitor lifecycle (attach/detach/shutdown)"
```

---

## Task 9: Polling fallback loop

**Files:**
- Modify: `rug-monitor.js` (wire polling tick + per-position scheduling)
- Modify: `tests/rug-monitor.test.js`

- [ ] **Step 1: Append failing tests**

```js
describe("polling fallback", () => {
  it("calls fetchers and emits HIGH on dev dump detected via polling", async () => {
    vi.useFakeTimers();
    const s = makeStubs();
    s.fetchers.getTokenBalance = vi.fn().mockResolvedValue(0);
    s.fetchers.getMintAccount = vi.fn().mockResolvedValue({ mint_authority: null, freeze_authority: null });
    s.fetchers.getLargestAccounts = vi.fn().mockResolvedValue([]);
    s.fetchers.getPoolLiquidityUsd = vi.fn().mockResolvedValue(25000);
    const rm = createRugMonitor(s);
    rm.attachPosition("M::W", {
      mint: "M", deployer_wallet: "D", lp_address: "L",
      top_holders_snapshot: [{ wallet: "H1", balance: 100 }],
      authorities: { mint_authority: null, freeze_authority: null },
      lp_usd_at_entry: 25000,
      deployer_balance_at_entry: 1000,
      entry_ts: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(s.callbacks.onHigh).toHaveBeenCalled();
    const [posKey, signalType, meta] = s.callbacks.onHigh.mock.calls[0];
    expect(posKey).toBe("M::W");
    expect(signalType).toBe("dev_sell");
    expect(meta.source).toBe("polling");
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: FAIL — `onHigh` not called (no polling implemented yet).

- [ ] **Step 3: Add polling loop inside `createRugMonitor`**

Append inside `createRugMonitor` before the returned object:

```js
const pollingMs = (config.pollingIntervalSec || 30) * 1000;

function _emit(state, positionKey, detector, severity, signalType, evidence, source) {
  if (!shouldEmit(severity, state.last_severity_emitted[detector])) return;
  state.last_severity_emitted[detector] = severity;
  const meta = { severity, signal_type: signalType, source, evidence, ts: Date.now() };
  if (severity === SEVERITY.HIGH && callbacks.onHigh) callbacks.onHigh(positionKey, signalType, meta);
  else if (severity === SEVERITY.MEDIUM && callbacks.onMedium) callbacks.onMedium(positionKey, signalType, meta);
  else if (severity === SEVERITY.LOW && callbacks.onLow) callbacks.onLow(positionKey, signalType, meta);
}

async function _pollOnce(positionKey, state) {
  if (state.shutdown) return;
  const { mint, deployer_wallet, lp_address, lp_usd_at_entry, top_holders_snapshot, authorities, deployer_balance_at_entry } = state.meta;

  // Dev sell
  try {
    const bal = await fetchers.getTokenBalance(deployer_wallet, mint);
    const sev = detectDevSell({ balanceAtEntry: deployer_balance_at_entry, currentBalance: bal, thresholds: config.devSellThresholds });
    _emit(state, positionKey, "dev_sell", sev, "dev_sell", { current: bal, atEntry: deployer_balance_at_entry }, "polling");
  } catch (e) { log("rug_monitor", `dev_sell poll failed for ${positionKey}: ${e.message}`); }

  // LP movement (USD comparison)
  try {
    const currentLpUsd = await fetchers.getPoolLiquidityUsd(lp_address);
    const sev = detectLpMovement({ lpAtEntry: lp_usd_at_entry, currentLp: currentLpUsd, deployerWallet: deployer_wallet, thresholds: config.lpMovementThresholds });
    _emit(state, positionKey, "lp", sev, "lp_movement", { current: currentLpUsd, atEntry: lp_usd_at_entry }, "polling");
  } catch (e) { log("rug_monitor", `lp poll failed for ${positionKey}: ${e.message}`); }

  // Authority change
  try {
    const mintAcct = await fetchers.getMintAccount(mint);
    const sev = detectAuthorityChange({ atEntry: authorities, current: mintAcct });
    _emit(state, positionKey, "authority", sev, "authority_change", { current: mintAcct, atEntry: authorities }, "polling");
  } catch (e) { log("rug_monitor", `authority poll failed for ${positionKey}: ${e.message}`); }

  // Holder dump (re-fetch top holders; compare to snapshot)
  try {
    const current = await fetchers.getLargestAccounts(mint);
    const snapshotMap = new Map((top_holders_snapshot || []).map(h => [h.wallet, h.balance]));
    const events = (current || []).map(h => ({ tsMs: Date.now(), deltaTokens: (h.balance || 0) - (snapshotMap.get(h.wallet) || 0) }));
    state.holder_events.push(...events);
    const cutoff = Date.now() - 5 * 60_000;
    state.holder_events = state.holder_events.filter(e => e.tsMs >= cutoff);
    const snapshotTotal = (top_holders_snapshot || []).reduce((s, h) => s + (h.balance || 0), 0);
    const sev = detectHolderDump({ snapshotTotal, events: state.holder_events, windowMs: 5 * 60_000, nowMs: Date.now(), thresholds: config.holderDumpThresholds });
    _emit(state, positionKey, "holders", sev, "holder_dump", { eventsCount: state.holder_events.length }, "polling");
  } catch (e) { log("rug_monitor", `holders poll failed for ${positionKey}: ${e.message}`); }
}

function _schedulePolling(positionKey, state) {
  if (state.shutdown) return;
  state.polling_handle = setTimeout(async () => {
    await _pollOnce(positionKey, state);
    _schedulePolling(positionKey, state);
  }, pollingMs);
}
```

Update `attachPosition` to schedule polling after state is created:
```js
function attachPosition(positionKey, meta) {
  if (shuttingDown) return;
  if (positions.has(positionKey)) {
    positions.get(positionKey).meta = { ...positions.get(positionKey).meta, ...meta };
    return;
  }
  const state = _newState(meta);
  positions.set(positionKey, state);
  _schedulePolling(positionKey, state);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: PASS (28 + 1 = 29 tests).

- [ ] **Step 5: Commit**

```bash
git add rug-monitor.js tests/rug-monitor.test.js
git commit -m "feat(rug-monitor): polling fallback loop calling all 4 detectors"
```

---

## Task 10: Geyser event routing

**Files:**
- Modify: `rug-monitor.js` (subscribe per position to deployer/lp/mint accounts; route events)
- Modify: `tests/rug-monitor.test.js`

- [ ] **Step 1: Append failing tests**

```js
describe("geyser event routing", () => {
  it("emits HIGH on dev_sell when geyser pushes balance to 0", () => {
    const s = makeStubs();
    let onDeployerAccount;
    s.geyserStream.subscribe = vi.fn((spec, handler) => {
      if (spec.account === "DeployerTokenAcct") onDeployerAccount = handler;
      return `sub-${spec.kind}`;
    });
    const rm = createRugMonitor(s);
    rm.attachPosition("M::W", {
      mint: "M", deployer_wallet: "D", deployer_token_account: "DeployerTokenAcct", lp_address: "L",
      top_holders_snapshot: [],
      authorities: { mint_authority: null, freeze_authority: null },
      deployer_balance_at_entry: 1000,
      lp_usd_at_entry: 25000,
      entry_ts: Date.now(),
    });
    onDeployerAccount({ tokenBalance: 0 });
    expect(s.callbacks.onHigh).toHaveBeenCalled();
    const [posKey, signalType, meta] = s.callbacks.onHigh.mock.calls[0];
    expect(posKey).toBe("M::W");
    expect(signalType).toBe("dev_sell");
    expect(meta.source).toBe("geyser");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: FAIL — `onHigh` not called (geyser routing not implemented).

- [ ] **Step 3: Add Geyser subscription inside `attachPosition`**

After `_schedulePolling(positionKey, state);` line, add:

```js
  if (geyserStream?.subscribe) {
    if (meta.deployer_token_account) {
      const sub = geyserStream.subscribe(
        { kind: "account", account: meta.deployer_token_account },
        (evt) => {
          const sev = detectDevSell({
            balanceAtEntry: meta.deployer_balance_at_entry,
            currentBalance: evt?.tokenBalance,
            thresholds: config.devSellThresholds,
          });
          _emit(state, positionKey, "dev_sell", sev, "dev_sell", { current: evt?.tokenBalance }, "geyser");
        }
      );
      state.geyser_subs.push(sub);
    }
    if (meta.lp_address) {
      const sub = geyserStream.subscribe(
        { kind: "account", account: meta.lp_address },
        (evt) => {
          const sev = detectLpMovement({
            lpAtEntry: meta.lp_usd_at_entry,
            currentLp: evt?.lpUsd ?? evt?.currentLp,
            transferTo: evt?.transferTo,
            removeLiquidityBy: evt?.removeLiquidityBy,
            deployerWallet: meta.deployer_wallet,
            thresholds: config.lpMovementThresholds,
          });
          _emit(state, positionKey, "lp", sev, "lp_movement", { evt }, "geyser");
        }
      );
      state.geyser_subs.push(sub);
    }
    if (meta.mint) {
      const sub = geyserStream.subscribe(
        { kind: "account", account: meta.mint },
        (evt) => {
          const sev = detectAuthorityChange({ atEntry: meta.authorities, current: evt });
          _emit(state, positionKey, "authority", sev, "authority_change", { current: evt }, "geyser");
        }
      );
      state.geyser_subs.push(sub);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rug-monitor.test.js`
Expected: PASS (29 + 1 = 30 tests).

- [ ] **Step 5: Commit**

```bash
git add rug-monitor.js tests/rug-monitor.test.js
git commit -m "feat(rug-monitor): Geyser event routing to detectors"
```

---

## Task 11: Integration with `index.js` (startup, attach, detach, shutdown)

**Files:**
- Modify: `index.js` (import + wire lifecycle hooks)
- No new test (integration smoke verified manually via dry-run)

- [ ] **Step 1: Add imports at top of `index.js`**

Find the existing imports block (around line 25–45). Add:
```js
import { createRugMonitor, SEVERITY } from "./rug-monitor.js";
import { captureEntryMetadata } from "./tools/entry-metadata.js";
```

- [ ] **Step 2: Define fetchers + callbacks just before `startTurboButtons` (search for that function)**

Inside the file scope, near other module-level variables, add:

```js
let rugMonitor = null;

const rugMonitorFetchers = {
  getMintInfo: async (mint) => {
    // Best-effort: combine existing rug-signals data with Helius mint info
    const { fetchHeliusMintAccount } = await import("./tools/rug-signals.js");
    return fetchHeliusMintAccount?.(mint) ?? null;
  },
  getPoolInfo: async (mint) => {
    const { fetchDexScreenerPool } = await import("./tools/dexscreener.js");
    const pool = await fetchDexScreenerPool?.(mint);
    return pool ? { pool_address: pool.pairAddress, lp_usd: pool.liquidityUsd } : null;
  },
  getTopHolders: async (mint) => {
    const { fetchTopHolders } = await import("./tools/rug-signals.js");
    return (await fetchTopHolders?.(mint, 10)) ?? [];
  },
  getTokenBalance: async (owner, mint) => {
    const { fetchTokenBalance } = await import("./tools/rug-signals.js");
    return fetchTokenBalance?.(owner, mint) ?? 0;
  },
  getMintAccount: async (mint) => {
    const { fetchHeliusMintAccount } = await import("./tools/rug-signals.js");
    return fetchHeliusMintAccount?.(mint) ?? { mint_authority: null, freeze_authority: null };
  },
  getLargestAccounts: async (mint) => {
    const { fetchTopHolders } = await import("./tools/rug-signals.js");
    return (await fetchTopHolders?.(mint, 10)) ?? [];
  },
  getPoolLiquidityUsd: async (poolAddr) => {
    const { fetchDexScreenerPoolByAddress } = await import("./tools/dexscreener.js");
    const p = await fetchDexScreenerPoolByAddress?.(poolAddr);
    return p?.liquidityUsd ?? null;
  },
};

function _ruglogPrefix(severityLevel, signalType, positionKey, meta) {
  const tag = severityLevel === "HIGH" ? "🔴" : severityLevel === "MEDIUM" ? "🟡" : "🟢";
  return `${tag} [RUG_MONITOR] ${severityLevel} on ${positionKey} signal=${signalType} src=${meta.source}`;
}

const rugMonitorCallbacks = {
  onLow: (positionKey, signalType, meta) => {
    log("rug_monitor", _ruglogPrefix("LOW", signalType, positionKey, meta));
    sendTelegram?.(`${_ruglogPrefix("LOW", signalType, positionKey, meta)}\nAction: tighten_trail`);
    // Tighten trailing: subtract 2pp from trailingTriggerPct floored at 1
    const pos = getState()?.positions?.[positionKey];
    if (pos) {
      pos.trailingTriggerPctOverride = Math.max(1, (pos.trailingTriggerPctOverride ?? config.management.trailingTriggerPct ?? 5) - 2);
    }
  },
  onMedium: async (positionKey, signalType, meta) => {
    log("rug_monitor", _ruglogPrefix("MEDIUM", signalType, positionKey, meta));
    sendTelegram?.(`${_ruglogPrefix("MEDIUM", signalType, positionKey, meta)}\nAction: sell 50%`);
    try { await sellPositionFraction?.(positionKey, 0.5, "rug_monitor_medium"); } catch (e) { log("rug_monitor", `sell_partial failed: ${e.message}`); }
  },
  onHigh: async (positionKey, signalType, meta) => {
    log("rug_monitor", _ruglogPrefix("HIGH", signalType, positionKey, meta));
    sendTelegram?.(`${_ruglogPrefix("HIGH", signalType, positionKey, meta)}\nAction: sellAll()`);
    try { await sellPositionFraction?.(positionKey, 1.0, "rug_monitor_high"); } catch (e) { log("rug_monitor", `sell_all failed: ${e.message}`); }
  },
};
```

- [ ] **Step 3: Create the monitor in `startTurboButtons` after `_geyserStream` is set**

Find where `attachExitMonitor(...)` is called. Just below it add:

```js
if (config.rugMonitor?.enabled) {
  rugMonitor = createRugMonitor({
    geyserStream: _geyserStream,
    config: config.rugMonitor,
    callbacks: rugMonitorCallbacks,
    fetchers: rugMonitorFetchers,
    log,
  });
  log("rug_monitor", `enabled (polling=${config.rugMonitor.pollingIntervalSec}s)`);
}
```

- [ ] **Step 4: Attach on successful entry (find `executePendingIntent` swap-success branch)**

After the `trackPosition(...)` call in `executePendingIntent` (search for it), add:

```js
if (rugMonitor) {
  try {
    const meta = await captureEntryMetadata(intent.mint, rugMonitorFetchers);
    rugMonitor.attachPosition(positionKey, {
      ...meta,
      deployer_balance_at_entry: meta.top_holders_snapshot?.find(h => h.wallet === meta.deployer_wallet)?.balance ?? 0,
    });
    log("rug_monitor", `attached ${positionKey} (partial=${meta.partial})`);
  } catch (e) {
    log("rug_monitor", `attach failed for ${positionKey}: ${e.message}`);
  }
}
```

- [ ] **Step 5: Detach on close (find `recordClose` call sites)**

After every `recordClose(positionKey, ...)` site, add:
```js
rugMonitor?.detachPosition(positionKey);
```

- [ ] **Step 6: Shutdown on SIGTERM (find existing SIGTERM handler)**

Inside the SIGTERM/SIGINT handler add (before existing `process.exit`):
```js
try { rugMonitor?.shutdown(); } catch (_) {}
```

- [ ] **Step 7: Run full test suite + dry-run**

Run: `npx vitest run`
Expected: PASS (all existing tests + new rug-monitor tests). No regressions.

Run: `timeout 20 node index.js --dry-run 2>&1 | tail -30`
Expected: see `[rug_monitor] enabled (polling=30s)` line in startup logs. No errors.

- [ ] **Step 8: Commit**

```bash
git add index.js
git commit -m "feat(rug-monitor): wire into index.js (startup, attach, detach, shutdown)"
```

---

## Task 12: Final integration test + verification

**Files:**
- Create: `tests/rug-monitor-integration.test.js`

- [ ] **Step 1: Write integration test**

Create `tests/rug-monitor-integration.test.js`:
```js
import { describe, expect, it, vi } from "vitest";
import { createRugMonitor, SEVERITY } from "../rug-monitor.js";

describe("rug-monitor integration", () => {
  const baseConfig = {
    enabled: true,
    pollingIntervalSec: 30,
    devSellThresholds: { low: -5, medium: -20, high: -50 },
    lpMovementThresholds: { low: -20, medium: -50, high: null },
    holderDumpThresholds: { low: -10, medium: -25, high: -50 },
    actions: { low: {}, medium: {}, high: {} },
  };

  function makeMeta(overrides = {}) {
    return {
      mint: "M", deployer_wallet: "D", deployer_token_account: "DTok", lp_address: "L",
      top_holders_snapshot: [{ wallet: "H1", balance: 5_000_000 }, { wallet: "H2", balance: 5_000_000 }],
      authorities: { mint_authority: null, freeze_authority: null },
      deployer_balance_at_entry: 1_000_000,
      lp_usd_at_entry: 25_000,
      entry_ts: Date.now(),
      ...overrides,
    };
  }

  it("3 concurrent positions: signal on 1 does not affect others", () => {
    const handlers = new Map();
    const geyserStream = {
      subscribe: vi.fn((spec, h) => { handlers.set(spec.account, h); return spec.account; }),
      unsubscribe: vi.fn(),
    };
    const callbacks = { onLow: vi.fn(), onMedium: vi.fn(), onHigh: vi.fn() };
    const fetchers = { getTokenBalance: vi.fn(), getMintAccount: vi.fn(), getLargestAccounts: vi.fn(), getPoolLiquidityUsd: vi.fn() };
    const rm = createRugMonitor({ geyserStream, config: baseConfig, callbacks, fetchers });

    rm.attachPosition("M1::W", makeMeta({ mint: "M1", deployer_token_account: "DTok1" }));
    rm.attachPosition("M2::W", makeMeta({ mint: "M2", deployer_token_account: "DTok2" }));
    rm.attachPosition("M3::W", makeMeta({ mint: "M3", deployer_token_account: "DTok3" }));

    handlers.get("DTok2")({ tokenBalance: 0 });

    expect(callbacks.onHigh).toHaveBeenCalledTimes(1);
    expect(callbacks.onHigh.mock.calls[0][0]).toBe("M2::W");
    rm.shutdown();
  });

  it("severity escalation: LOW then MEDIUM both emit, MEDIUM then LOW does not downgrade", () => {
    const handlers = new Map();
    const geyserStream = { subscribe: vi.fn((spec, h) => { handlers.set(spec.account, h); return spec.account; }), unsubscribe: vi.fn() };
    const callbacks = { onLow: vi.fn(), onMedium: vi.fn(), onHigh: vi.fn() };
    const fetchers = { getTokenBalance: vi.fn(), getMintAccount: vi.fn(), getLargestAccounts: vi.fn(), getPoolLiquidityUsd: vi.fn() };
    const rm = createRugMonitor({ geyserStream, config: baseConfig, callbacks, fetchers });
    rm.attachPosition("M::W", makeMeta());

    handlers.get("DTok")({ tokenBalance: 900_000 }); // -10% → LOW
    handlers.get("DTok")({ tokenBalance: 700_000 }); // -30% → MEDIUM
    handlers.get("DTok")({ tokenBalance: 850_000 }); // -15% → LOW; should not re-emit (no downgrade)

    expect(callbacks.onLow).toHaveBeenCalledTimes(1);
    expect(callbacks.onMedium).toHaveBeenCalledTimes(1);
    expect(callbacks.onHigh).not.toHaveBeenCalled();
    rm.shutdown();
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run tests/rug-monitor-integration.test.js`
Expected: PASS (2 tests).

- [ ] **Step 3: Run full suite for regression check**

Run: `npx vitest run`
Expected: All tests pass (existing 315 + new ~31 rug-monitor = ~346 total).

- [ ] **Step 4: Dry-run smoke**

Run: `timeout 20 node index.js --dry-run 2>&1 | grep -E "rug_monitor|RUG_MONITOR|ERROR"`
Expected: see `[rug_monitor] enabled` line, no ERROR lines.

- [ ] **Step 5: Commit**

```bash
git add tests/rug-monitor-integration.test.js
git commit -m "test(rug-monitor): integration suite (concurrent positions + escalation)"
```

---

## Self-Review Checklist

After all tasks complete:
- [ ] Spec coverage: each section of `docs/superpowers/specs/2026-05-20-rug-monitor-design.md` has a corresponding task (architecture=Tasks 8–11; 4 detectors=Tasks 3–6; severity=Task 2; metadata=Task 7; polling=Task 9; geyser=Task 10; integration=Task 11; tests=Tasks 2–6, 12; config=Task 1)
- [ ] No placeholders / TBDs in the code shown in any step
- [ ] Type/name consistency: `SEVERITY`, `detectDevSell`, `detectLpMovement`, `detectAuthorityChange`, `detectHolderDump`, `aggregateSeverity`, `shouldEmit`, `createRugMonitor`, `captureEntryMetadata` are used identically across all tasks
- [ ] Test names match across tasks (no rename mid-plan)
