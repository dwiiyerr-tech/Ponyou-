#!/usr/bin/env bash
# addtask.sh — Add a new task to PR_QUEUE.md via /newtask
# Usage: ./addtask.sh <task description>
# Example: ./addtask.sh Build daily PnL dashboard with Telegram output
#
# This calls /newtask which will:
#   - Assign next PR-XXX ID automatically
#   - Set Status: pending
#   - Append to PR_QUEUE.md
#   - Update PR_PROGRESS.md

set -euo pipefail
cd "$(dirname "$0")" || exit 1

TASK="$*"
if [[ -z "$TASK" ]]; then
  echo "Usage: ./addtask.sh <task description>"
  echo "Example: ./addtask.sh Build daily PnL dashboard with Telegram output"
  exit 1
fi

echo "Adding task: $TASK"
claude -p "/newtask $TASK" --output-format text

echo ""
echo "Done. Run ./run-autowork.sh to start working on it."
