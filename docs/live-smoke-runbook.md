# Live-Mode Micro-Capital Smoke Test — Operator Runbook

This runbook validates the audit fixes (acf408d through 345728e) against
**real on-chain execution** with a deliberately small wallet budget
(≤ 0.05 SOL ≈ $10). It is **operator-driven** — the sandbox cannot run
this autonomously because it requires:

- A funded Solana wallet
- A real GitHub PAT to push the branch
- Manual approval at several decision gates

Estimated wall time: **~45 minutes** of attention spread over ~6 hours of
runtime.

> ⚠️ This is a live-fire test. The bot WILL place real trades. Run only
> after the demo-mode walkthrough below succeeds and you've reviewed each
> step. Stop at any gate if behavior diverges from expected.

## Pre-flight (do this first, in demo mode)

1. **Fresh clone** of `claude/audit-and-fixes-2026-05-28` branch into a
   throwaway directory:
   ```bash
   git clone -b claude/audit-and-fixes-2026-05-28 \
     https://github.com/dwiiyerr-tech/Ponyou-.git ponyou-smoke && cd ponyou-smoke
   npm install
   ```
2. **Run the test suite** — must be green:
   ```bash
   npm test
   # expect: 1129+ passed (0 failed)
   ```
3. **Readiness check** — demo mode:
   ```bash
   npm run readiness
   # expect: Status: OK
   ```
4. **Demo smoke** — let it run 10 minutes, then confirm logs are clean:
   ```bash
   npm run dev > /tmp/demo.log 2>&1 &
   sleep 600
   pkill -f "node.*index.js"
   grep -E "FATAL|FAIL|cron_error|config_warn|jupiter_warn|management_error" /tmp/demo.log
   # expect: no FATAL/FAIL lines. config_warn / jupiter_warn lines are OK
   #         only if they describe expected-disabled features.
   ```

## Stage 1 — Wallet setup (5 min)

> Use a **brand new wallet**. Do not reuse your main trading wallet.

1. Generate or import a fresh Solana keypair. Save its base58 private key
   to a secure location.
2. Fund the wallet with **exactly 0.05 SOL** (about $10 at current
   prices). Send from your main wallet or a CEX withdrawal.
3. Configure user-config.json (or the wizard):
   - `walletAddress`: the new wallet's pubkey
   - `executionMode`: `live`
   - `deployAmountSol`: `0.01` (each entry ≤ 0.01 SOL → max 5 positions)
   - `maxPositions`: `2` (cap concurrent risk)
   - `gasReserve`: `0.005` (always keeps gas headroom)
   - `confirmMode`: `true` ← every BUY requires `/yes <id>` in Telegram
   - `pilotEnabled`: `true`, `pilotCapitalUsd`: `10`
   - `dailyStopLossPct`: `-15`
4. Set `WALLET_PRIVATE_KEY=<base58 key>` in `.env`. Do **not** commit it.

## Stage 2 — Pre-trade verification (5 min)

1. **Live readiness check** — must pass before unlocking trades:
   ```bash
   npm run readiness:live
   # expect: Status: OK, Mode: LIVE
   ```
2. **Start with automation OFF** so the first cycle is observation-only:
   ```bash
   EXECUTION_MODE=live node --disable-warning=DEP0040 index.js > /tmp/live.log 2>&1 &
   ```
3. Watch the first 5 minutes of `/tmp/live.log`. Expected lines:
   - `[STARTUP] Multi-Agent System: 7/7 agents running (1 locked)`
   - `[WALLET_MGR]` shows your new wallet address
   - `[READINESS] Readiness OK for LIVE mode`
   - No `[FATAL]`, no `[swap_error]`, no `[jupiter_warn]` outside expected
4. Telegram: send `/menu`. Bot replies with current config snapshot.
   Confirm `confirm=ON`, `auto=OFF` initially.

## Stage 3 — First buy via confirm-mode (~10 min)

1. Enable automation: `/auto on` in Telegram (or `/auto`).
2. Wait for the next screening cycle (`screen=5m` by default). When a
   candidate passes the gates, Ponyou queues an intent and posts:
   ```
   🟡 Pending BUY · #N
   0.01 SOL → <mint>
   Strategy: <id> · expires 10m
   /yes N · /no N
   ```
3. **Review the candidate** in the Telegram message:
   - mcap looks reasonable for the strategy
   - rug-score available
4. Approve with `/yes <id>`. Expect Jupiter swap to land within ~10s.
   Verify:
   ```
   ✅ Buy · <symbol>
   tx: <signature> · 0.01 SOL → ~<amount> <token>
   ```
   Cross-check the tx on solscan.io.
5. Note the entry timestamp — the **MGMT-3 hard guard** will block any
   LLM-initiated sell of this position for the first 5 minutes.

## Stage 4 — Validate the audit fixes against live behavior (~3 hours)

While the position is open, watch logs for these specific lines that
prove each fix is operating correctly:

- **MGMT-1** (real PnL on LLM exits): when an LLM exit fires (if it
  does), look for `[management_warn]` if PnL cannot be computed, OR a
  `recordTrade` log indicating real win/loss (not always-true).
- **MGMT-2** (per-exit isolation): force a bookkeeping fault by stopping
  state.json mid-cycle? Skip — too risky for live test. Verify in demo
  separately.
- **MGMT-3** (managed guard): send a test prompt to the LLM asking it
  to sell the brand-new position. Expect tool result:
  ```
  Managed-window guard: <mint> only X.Xmin old (min 5min)...
  ```
- **trash-filter S3**: not directly observable — manifests as more
  candidates passing through. Compare `[SOCIAL_GATE]` vs `[TRASH_FILTER]
  BLOCKED ... supply_invalid` ratio. After fix, supply_invalid should
  only appear for tokens with explicit zero supply.
- **executor EX-6**: try `update_config({"changes":{"managementIntervalMin":0}})`
  via the LLM tool. Expect a `[config_warn]` log + the value clamped to 1.
- **Jupiter J11**: each successful swap should log a sane price-impact
  in percent (not the previous `0.00%` for non-zero impact).
- **rug-monitor RM-7**: if a token rugs while watched, the holder-dump
  detection should fire AT MOST after real movement, not after N polls of
  the same state. Hard to verify in 3 hours; defer to extended run.

## Stage 5 — Exit (~30 min after entry, OR strategy ROI hits)

The bot will exit automatically when ROI threshold or stoploss is hit.
Watch for:

```
🎯 Exit · <symbol> · PnL: +X.X% / -X.X%
```

After exit, verify in Telegram with `/pnl`:

```
session: closed 1 · win N · loss M · pnl +/- $X
```

Cross-reference against solscan tx to confirm SOL received matches log.

## Stage 6 — Stop and review (~10 min)

1. `/auto off` to disable automation.
2. `/off` to gracefully shutdown the bot.
3. Inspect `state.json`, `performance.json`, `learning-state.json`,
   `lessons.json`. All should reflect the trade(s) executed.
4. Push the wallet back to your main wallet:
   ```bash
   solana transfer <main-wallet> ALL --keypair /path/to/smoke-wallet.json --allow-unfunded-recipient
   ```
   (keep enough SOL for the transfer fee)
5. **Move the smoke wallet key to cold storage or destroy it**.

## Acceptance criteria

The smoke test passes if **all** of the following are true:

- [ ] At least one full BUY → EXIT cycle completed on-chain
- [ ] PnL reported by Ponyou matches solscan accounting (within 0.5%)
- [ ] MGMT-3 guard demonstrably blocked an LLM-initiated young-position sell
- [ ] No `[FATAL]` or `[cron_error]` lines in the live log
- [ ] State files (`state.json`, etc.) are consistent with executed trades
- [ ] Test suite still green after pull from the branch

## Failure modes to abort on

Stop the bot immediately (`/off`) if you see:

- `[swap_error]` repeated > 3 times for the same mint
- Multiple `[management_warn]` lines for the same exit (potential MGMT-1 fallback abuse)
- Wallet balance drops below `gasReserve` (0.005 SOL)
- Any `[FATAL]` line
- Telegram bot stops responding to `/menu`

After aborting, capture:
- The full `/tmp/live.log`
- `state.json`, `metrics.json`, `performance.json`
- Solscan link to any in-flight tx

Open an issue against the branch with the captured data. Do NOT retry
without root-cause analysis.

## Notes

- This runbook intentionally **does not** automate `solana transfer`
  refund / wallet destruction — those are manual to keep human-in-loop
  on the smoke account.
- The 0.05 SOL budget is the operational floor; reduce to 0.02 SOL
  ($4) for a "stress test the gates without a real BUY" variant.
- If you want to skip Telegram approval, set `confirmMode: false`
  in user-config — but **only after** Stage 3 succeeds at least once
  with confirm on.
