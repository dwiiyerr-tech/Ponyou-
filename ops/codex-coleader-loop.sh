#!/usr/bin/env bash
# =============================================================================
# codex-coleader-loop.sh — Codex co-leader for Claude AutoWork
# =============================================================================
# Runs Codex non-interactively as the build/testing co-leader. Claude remains the
# decision gate; this loop only handles Codex-owned implementation/test tasks and
# writes handoffs back to PR_QUEUE.md, PR_PROGRESS.md, and the collaboration layer.
#
# Usage:
#   bash ops/codex-coleader-loop.sh [--once] [--interval 300] [--log codex-coleader.log]
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

LOG="codex-coleader.log"
INTERVAL=300
ONCE=false
PID_FILE="codex-coleader.pid"
LAST_MESSAGE="codex-coleader-last.md"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once) ONCE=true; shift ;;
    --interval) INTERVAL="${2:?--interval requires a value}"; shift 2 ;;
    --log) LOG="${2:?--log requires a value}"; shift 2 ;;
    -h|--help)
      sed -n '/^# Usage:/,/^# ===/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log() { echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") [$1] ${*:2}" | tee -a "$LOG"; }

is_pid_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

queue_has_codex_work() {
  [[ -s PR_QUEUE.md ]] || return 1
  grep -qE '^Status: (pending|in_progress)' PR_QUEUE.md || return 1
  grep -q '(worker: codex)' PR_QUEUE.md || return 1
}

human_approval_needed() {
  grep -q "^Human approval needed: yes" PR_PROGRESS.md 2>/dev/null
}

cleanup() {
  log INFO "Codex co-leader loop stopping (PID=$$)."
  rm -f "$PID_FILE"
}
trap cleanup EXIT INT TERM

if is_pid_running && [[ "$(cat "$PID_FILE")" != "$$" ]]; then
  log WARN "Codex co-leader already running. PID=$(cat "$PID_FILE")"
  exit 0
fi

echo $$ > "$PID_FILE"
log INFO "Codex co-leader loop started. PID=$$. Log=$LOG"

build_prompt() {
  cat <<'PROMPT'
You are Codex co-leader for Ponyou AutoWork, working beside Claude.

Operating contract:
- Claude remains chief architect and final decision/review gate.
- Codex owns code writing, technical research needed for implementation, and tests.
- Gemini remains optional research/counter-argument arm when available.
- Use PR_QUEUE.md, PR_PROGRESS.md, shared-agent-memory.jsonl, and infra/agent-collab as source of truth.
- Do not start or stop background loops. Do not call this co-leader script recursively.
- Do not touch secrets, wallets, LIVE_TRADING, DRY_RUN defaults, or systemd service files.
- Do not execute live trades or network trading calls.
- Keep each run bounded to exactly one PR or one orchestration handoff.

Selection order:
1. Run `npm run collab:status` and `npm run collab:next -- --owner codex --for codex`.
2. If there is an open Codex handoff, handle exactly that handoff.
3. Otherwise inspect PR_QUEUE.md and pick the first PR with Status pending/in_progress that has unchecked `(worker: codex)` tasks.
4. If PR_QUEUE already shows earlier Codex tasks completed locally, do not redo them; advance to the next unchecked Codex task/PR.

Implementation rules:
- Prefer existing repo patterns and plain ESM JS modules.
- New analysis modules must be analysis-only and must never return BUY/SELL unless PR_QUEUE explicitly requires it; even then no execution.
- Add focused tests matching risk/blast radius.
- Run syntax checks and focused tests. Run full `npx vitest run` only if the change is broad or after several PRs are ready.
- Stop after one PR/task, even if more work remains.

Handoff/update requirements before final response:
- Update PR_QUEUE.md checkboxes/status for completed Codex-owned tasks.
- Add concise notes to PR_PROGRESS.md under the non-auto history/notes area, without corrupting the AutoWork generated block.
- If an orchestration task id exists, submit Codex results with `npm run collab:submit -- --task-id <id> --worker codex ...`.
- Include files changed and verification in the final message.
PROMPT
}

run_once() {
  if human_approval_needed; then
    log WARN "Human approval gate active (PR_PROGRESS.md). Codex co-leader paused. Sleeping ${INTERVAL}s."
    return 3
  fi

  if ! queue_has_codex_work; then
    log INFO "No pending/in_progress Codex work found in PR_QUEUE.md."
    return 2
  fi

  log INFO "Running Codex co-leader cycle..."
  if codex exec \
    -C "$(pwd)" \
    --dangerously-bypass-approvals-and-sandbox \
    --dangerously-bypass-hook-trust \
    -o "$LAST_MESSAGE" \
    "$(build_prompt)" >> "$LOG" 2>&1; then
    log INFO "Codex co-leader cycle completed. Last message: $LAST_MESSAGE"
  else
    log ERROR "Codex co-leader cycle failed. Check $LOG."
  fi
}

while true; do
  run_once; RESULT=$?
  [[ "$ONCE" == "true" ]] && break
  case $RESULT in
    3) sleep $((INTERVAL * 6)) ;;  # human approval gate: sleep 30min (6x default)
    *) sleep "$INTERVAL" ;;
  esac
done

log INFO "Codex co-leader loop exited."
