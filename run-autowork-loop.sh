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

get_current_pr() {
  grep -m1 "^Current PR:" PR_PROGRESS.md 2>/dev/null | awk '{print $NF}' || echo ""
}

# Returns 0 (true) if current PR has Safety: safe
current_pr_is_safe() {
  local PR
  PR=$(get_current_pr)
  [[ -z "$PR" ]] && return 1
  # Find the PR block and check its Safety field
  awk "/^## ${PR}:/,/^---/" PR_QUEUE.md 2>/dev/null | grep -q "^Safety: safe"
}

# Returns 0 (true) if all tasks in current PR are checked [x]
all_tasks_checked() {
  local PR
  PR=$(get_current_pr)
  [[ -z "$PR" ]] && return 1
  local block
  block=$(awk "/^## ${PR}:/,/^---/" PR_QUEUE.md 2>/dev/null)
  echo "$block" | grep -q "^\- \[ \]" && return 1  # unchecked task exists
  return 0
}

# Auto-implement: commit untracked/modified files and mark PR done
auto_implement() {
  local PR
  PR=$(get_current_pr)
  log INFO "Auto-implement: ${PR} is safe + all tasks checked. Committing and marking done."

  # Stage untracked tools/ and tests/ files (new implementations)
  local new_files
  new_files=$(git ls-files --others --exclude-standard tools/ tests/ 2>/dev/null || true)
  if [[ -n "$new_files" ]]; then
    echo "$new_files" | xargs git add --
  fi

  # Stage PR_QUEUE.md and PR_PROGRESS.md updates
  git add PR_QUEUE.md PR_PROGRESS.md 2>/dev/null || true

  # Only commit if there's something staged
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "feat(autowork): auto-implement ${PR} — all tasks done, safety=safe

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" >> "$LOG" 2>&1 && \
      log INFO "Auto-implement commit created for ${PR}."
  fi

  # Mark PR done in queue
  sed -i "s/^Status: ready_for_review/Status: done/" PR_QUEUE.md 2>/dev/null || true
  log INFO "${PR} marked done."
}

human_approval_needed() {
  grep -q "^Human approval needed: yes" PR_PROGRESS.md 2>/dev/null
}

run_once() {
  local STATUS
  STATUS=$(get_status)

  # Guards
  if queue_empty; then
    log INFO "Queue empty or all PRs done. Sleeping ${DONE_WAIT}s."
    return 2  # signal: nothing to do
  fi

  if human_approval_needed; then
    log WARN "Human approval gate active (PR_PROGRESS.md). Loop paused until human approves. Sleeping ${LIMIT_WAIT}s."
    return 5
  fi

  case "$STATUS" in
    ready_for_review)
      if current_pr_is_safe && all_tasks_checked; then
        auto_implement
        return 0  # re-run immediately; PR now done
      fi
      log INFO "Status: ready_for_review — needs human review (safety!=safe). Sleeping ${REVIEW_WAIT}s."
      return 3 ;;
    paused_by_limit)
      log WARN "Status: paused_by_limit — token limit hit. Sleeping ${LIMIT_WAIT}s before retry."
      return 4 ;;
  esac

  # Gap scan — detects stuck PRs, modules without tests, unwired tools
  node gap-agent.js --threshold 1 --output gap-report.md >> "$LOG" 2>&1 \
    && log INFO "Gap scan: clean." \
    || log WARN "Gap scan: issues found — see gap-report.md"

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
    5) sleep "$LIMIT_WAIT" ;;
    *) sleep "$INTERVAL" ;;
  esac
done

log INFO "AutoWork loop exited."
