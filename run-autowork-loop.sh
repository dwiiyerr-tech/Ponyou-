#!/usr/bin/env bash
# =============================================================================
# run-autowork-loop.sh — Persistent AutoWork loop runner
# =============================================================================
# Runs /autowork in a continuous loop. Safe to leave running in tmux, nohup,
# or via systemd. Handles all pause/resume/limit states automatically.
#
# USAGE
#   ./run-autowork-loop.sh [--once] [--interval 120] [--log FILE]
#
# OPTIONS
#   --once           Run one iteration then exit (same as run-autowork.sh)
#   --interval N     Seconds to wait between normal runs (default: 120)
#   --log FILE       Log file path (default: claude-autowork.log)
#
# PERSISTENT METHODS (see setup-autowork.sh for automated setup)
#
#   tmux:
#     tmux new-session -d -s autowork -c "$(pwd)" './run-autowork-loop.sh'
#     tmux attach -t autowork         # view output
#     tmux send-keys -t autowork q Enter  # stop
#
#   nohup:
#     nohup ./run-autowork-loop.sh >> claude-autowork.log 2>&1 &
#     echo $! > autowork.pid          # save PID
#     kill $(cat autowork.pid)        # stop
#
#   systemd:
#     sudo cp autowork.service /etc/systemd/system/
#     sudo systemctl enable --now autowork
#     sudo systemctl status autowork
#     sudo systemctl stop autowork
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")" || exit 1

# ── Defaults ──────────────────────────────────────────────────────────────────
LOG="claude-autowork.log"
INTERVAL=120           # seconds between normal runs
LIMIT_WAIT=1800        # seconds to wait when paused_by_limit (30 min)
REVIEW_WAIT=300        # seconds to poll when ready_for_review (5 min)
DONE_WAIT=600          # seconds to poll when all PRs are done (10 min)
ONCE=false

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --once)          ONCE=true; shift ;;
    --interval)      INTERVAL="${2:?--interval requires a value}"; shift 2 ;;
    --log)           LOG="${2:?--log requires a value}"; shift 2 ;;
    --limit-wait)    LIMIT_WAIT="${2:?}"; shift 2 ;;
    -h|--help)
      sed -n '/^# USAGE/,/^# ===/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
log() { echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") [$1] ${*:2}" | tee -a "$LOG"; }

queue_empty() {
  [[ ! -s PR_QUEUE.md ]] && return 0
  ! grep -qE "^Status: (pending|in_progress)" PR_QUEUE.md 2>/dev/null && return 0
  return 1
}

get_status() {
  grep -m1 "^Current status:" PR_PROGRESS.md 2>/dev/null | awk '{print $NF}' || echo "unknown"
}

run_once() {
  local STATUS
  STATUS=$(get_status)

  # Guards
  if queue_empty; then
    log INFO "Queue empty or all PRs done. Sleeping ${DONE_WAIT}s."
    return 2  # signal: nothing to do
  fi

  case "$STATUS" in
    ready_for_review)
      log INFO "Status: ready_for_review — waiting for human. Sleeping ${REVIEW_WAIT}s."
      return 3 ;;
    paused_by_limit)
      log WARN "Status: paused_by_limit — token limit hit. Sleeping ${LIMIT_WAIT}s before retry."
      return 4 ;;
  esac

  log INFO "Running /autowork..."
  if claude -c -p "/autowork auto-run. Continue from PR_PROGRESS.md and PR_QUEUE.md. Pause if limit appears and write next PR plan." \
    --output-format text \
    --max-turns 10 >> "$LOG" 2>&1; then
    log INFO "/autowork completed successfully."
  else
    log ERROR "/autowork exited non-zero. Check $LOG."
  fi
  return 0
}

# ── Main loop ─────────────────────────────────────────────────────────────────
log INFO "AutoWork loop started. PID=$$. Log=$LOG"
echo $$ > autowork.pid

cleanup() {
  log INFO "AutoWork loop stopping (PID=$$)."
  rm -f autowork.pid
}
trap cleanup EXIT INT TERM

while true; do
  run_once
  RESULT=$?

  [[ "$ONCE" == "true" ]] && break

  case $RESULT in
    0) sleep "$INTERVAL" ;;
    2) sleep "$DONE_WAIT" ;;
    3) sleep "$REVIEW_WAIT" ;;
    4) sleep "$LIMIT_WAIT" ;;
    *) sleep "$INTERVAL" ;;
  esac
done

log INFO "AutoWork loop exited."
