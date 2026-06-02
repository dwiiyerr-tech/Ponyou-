#!/usr/bin/env bash
# ops/monitor-keepalive.sh — Keep Claude Code alive in tmux pane "claude-ai".
#
# Called by the cron keepalive check every 30 min.
# If the tmux session or claude-ai window is dead, restarts it.
# Also ensures the bot supervisor is running.

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="ponyou"
WINDOW="claude-ai"
LOG="$ROOT_DIR/logs/supervisor/monitor-keepalive.log"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

# ── Check + restart tmux session ────────────────────────────────
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  log "Session '$SESSION' missing — relaunching..."
  tmux new-session -d -s "$SESSION" -n "$WINDOW" -x 220 -y 50
  tmux send-keys -t "$SESSION:$WINDOW" \
    "cd $ROOT_DIR && echo 'Claude Code monitoring session (restarted)' && claude" Enter
  log "Session relaunched"
fi

# ── Check bot supervisor ─────────────────────────────────────────
if ! pgrep -f "run-24x7.sh demo" > /dev/null 2>&1; then
  log "Supervisor dead — relaunching..."
  setsid bash "$ROOT_DIR/ops/run-24x7.sh" demo \
    >> "$ROOT_DIR/logs/supervisor/supervisor-demo.log" 2>&1 < /dev/null &
  log "Supervisor relaunched (pid=$!)"
fi

log "Keepalive OK"
