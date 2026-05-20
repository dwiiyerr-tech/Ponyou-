#!/usr/bin/env bash
# run-autowork.sh — auto-run /autowork for this project
# Usage: ./run-autowork.sh [--dry-run]
#
# Skips if:
#   - PR_QUEUE.md is empty or missing
#   - current PR status is ready_for_review (waiting for human)
#   - current PR status is paused_by_limit (run /limitplan first)
#
# Logs to: claude-autowork.log

set -euo pipefail
cd "$(dirname "$0")" || exit 1

LOG="claude-autowork.log"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

log() { echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") $*" | tee -a "$LOG"; }

# Check PR_QUEUE.md exists and has content
if [[ ! -s PR_QUEUE.md ]]; then
  log "PR_QUEUE.md empty or missing. Nothing to do."
  exit 0
fi

# Skip if waiting for human review
if grep -q "Current status: ready_for_review" PR_PROGRESS.md 2>/dev/null; then
  log "Status: ready_for_review — waiting for human review. Skipping."
  exit 0
fi

# Skip if paused by limit (run /limitplan to plan resume)
if grep -q "Current status: paused_by_limit" PR_PROGRESS.md 2>/dev/null; then
  log "Status: paused_by_limit — token limit was hit. Run /limitplan to plan resume, then re-run."
  exit 0
fi

# Skip if all PRs are done
if ! grep -qE "^Status: (pending|in_progress)" PR_QUEUE.md 2>/dev/null; then
  log "All PRs are done or ready_for_review. Nothing pending."
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY RUN — would run: claude -c -p \"/autowork auto-run. Continue from PR_PROGRESS.md and PR_QUEUE.md.\""
  exit 0
fi

log "Starting /autowork..."
claude -c -p "/autowork auto-run. Continue from PR_PROGRESS.md and PR_QUEUE.md. Pause if limit appears and write next PR plan." \
  --output-format text \
  --max-turns 10 >> "$LOG" 2>&1

log "Done. Check $LOG and PR_PROGRESS.md for results."
