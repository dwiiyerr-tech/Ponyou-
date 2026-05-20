# PR Queue

<!--
HOW TO USE
==========
Add tasks here manually or via:  ./addtask.sh <description>
Work tasks via:                  /autowork   (or run-autowork.sh)
Plan after limit:                /limitplan

STATUS VALUES
  pending         → not started
  in_progress     → being worked on now
  paused_by_limit → stopped due to token/usage limit
  ready_for_review→ done, needs human review
  done            → confirmed complete by human
-->

---

## PR-001: Daily Trade Guard — win/loss limit gate with Telegram decision flow
Status: done
Priority: high
Safety: safe
Goal: Implement a per-day win/loss counter that blocks new entries when a configurable limit is reached, sends a Telegram decision prompt (/continue or /stoptrade), and feeds outcome data into deep learning mode.
Tasks:
- [x] Create daily-trade-guard.js with state management
- [x] Add normalizeDailyTradeGuardConfig to config.js
- [x] Wire recordDailyTradeOutcome into trade exit handler in index.js
- [x] Add /continue and /stoptrade Telegram command handlers
- [x] Add /dailyguard and /resetguard commands
- [x] Add dailyGuard status line to /status output
- [x] Add buildDailyGuardAnalysisPrompt to learning-mode.js
- [x] Write tests/daily-trade-guard.test.js (4 tests, all passing)
Added: 2026-05-21
Completed: 2026-05-21

---

<!--
TEMPLATE — copy and fill in for new PRs
========================================

## PR-XXX: <short title>
Status: pending
Priority: <high | medium | low>
Safety: <safe | needs_review>
Goal: <one-line description of what this PR achieves>
Tasks:
- [ ] <task 1>
- [ ] <task 2>
Added: <YYYY-MM-DD>

-->
