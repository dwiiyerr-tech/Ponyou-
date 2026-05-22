# PR Progress

<!--
This file is auto-updated by /autowork after every run.
Do not edit the "## AutoWork Progress" block manually — it will be overwritten.
You can add notes below the divider line.
-->

---

## AutoWork Progress

Updated: 2026-05-22T07:45:00Z

Current PR: PR-014
Current status: ready_for_review

### Agents used
- Claude: orchestration + implementation + review

### Completed work
- recordRuggedNarrativesForExit already wired at index.js:1455 + 1646 (both exit paths)
- smart-wallets.js: normalizeWalletRecord now preserves last_active field (root cause: decay filter was broken because field was dropped)
- geyser.js:311: listSmartWallets({ minDecayMultiplier: 0.5 }) — zombies excluded from initial Geyser subscriptions
- index.js:2267: seedSmartWallets() counts only active wallets (multiplier >= 0.5) to decide if seeding needed
- partial-tp-guard.js: already implemented + wired (isPartialTPLanded/markPartialTPLanded at index.js:1321/1346)
- tests/pr014-integration.test.js: 5 tests — narrative feedback + decay filter
- tests/partial-tp-guard.test.js: 4 tests — idempotency, clear, prune

### Remaining work
- none

### Changed files
- smart-wallets.js (normalizeWalletRecord + last_active preservation)
- geyser.js (listSmartWallets with minDecayMultiplier: 0.5)
- index.js (seedSmartWallets decay-aware check)
- PR_QUEUE.md (status + checkboxes)
- PR_PROGRESS.md (this file)

### Tests run
- npx vitest run tests/pr014-integration.test.js tests/partial-tp-guard.test.js → PASS 9/9, FAIL 0
- npx vitest run → PASS 632/632, FAIL 0

### Limit status
clear

### Resume command
claude -c -p "/autowork resume from PR_PROGRESS.md and PR_QUEUE.md"

### Human approval needed
no

### Next action
PR-014 ready for review. Next: PR-015 (State Pruning + Kelly Outlier Cap)

---

<!--
HISTORY
=======
Entries above are overwritten each run.
Add permanent notes below this line.
-->

## Notes
- 2026-05-22: PR-012 full dashboard built by Claude directly (Codex CLI broken — sandbox policy blocks all write modes). All 15 tasks complete in single session. 612 tests pass. Start: node dashboard.js --port 3000.
- 2026-05-22 20:00 +08: Codex co-leader loop enabled via ops/codex-coleader-loop.sh. Claude remains final review/decision gate; Codex handles build/test tasks.
- daily-trade-guard.js uses file-based state (daily-trade-guard-state.json) — auto-reset on UTC date change
- Guard is disabled by default (dailyTradeGuard.enabled: false in config) — enable via user-config.json
- /stoptrade activates learning mode for learningModeDurationMin minutes
