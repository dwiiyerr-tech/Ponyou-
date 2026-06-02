#!/usr/bin/env bash
# ops/start-monitor.sh — Launch Ponyou 3-day monitoring session in tmux.
#
# Creates two tmux windows:
#   0: ponyou-bot  — supervisor + bot logs (tail -f)
#   1: ponyou-ai   — Claude Code session (the monitoring AI, keeps cron alive)
#
# Usage:
#   ./ops/start-monitor.sh          # start fresh
#   ./ops/start-monitor.sh attach   # attach to existing session
#   ./ops/start-monitor.sh status   # show session status
#
# The session is named "ponyou" so you can always reattach with:
#   tmux attach -t ponyou

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="ponyou"

case "${1:-}" in
  attach)
    tmux attach -t "$SESSION"
    exit 0
    ;;
  status)
    echo "=== tmux sessions ==="
    tmux list-sessions 2>/dev/null || echo "(no sessions)"
    echo ""
    echo "=== ponyou windows ==="
    tmux list-windows -t "$SESSION" 2>/dev/null || echo "(session not found)"
    echo ""
    echo "=== supervisor state ==="
    cat "$ROOT_DIR/supervisor-state.json" 2>/dev/null || echo "(no state)"
    exit 0
    ;;
esac

# ── Kill stale session if exists ────────────────────────────────
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists — attaching..."
  tmux attach -t "$SESSION"
  exit 0
fi

# ── Create new detached session ──────────────────────────────────
echo "Creating tmux session '$SESSION'..."
tmux new-session -d -s "$SESSION" -n "bot-logs" -x 220 -y 50

# Window 0: bot-logs — tail supervisor + agent log
tmux send-keys -t "$SESSION:bot-logs" \
  "cd $ROOT_DIR && echo '=== Bot Logs ===' && tail -f logs/supervisor/agent-demo.log 2>/dev/null || echo 'waiting for log...'" Enter

# Window 1: claude-ai — the Claude Code monitoring session
tmux new-window -t "$SESSION" -n "claude-ai"
tmux send-keys -t "$SESSION:claude-ai" \
  "cd $ROOT_DIR && echo 'Starting Claude Code monitoring session...' && sleep 1 && claude" Enter

# Window 2: shell — quick commands / fixes
tmux new-window -t "$SESSION" -n "shell"
tmux send-keys -t "$SESSION:shell" \
  "cd $ROOT_DIR && echo 'Ponyou monitoring shell — $(date)' && git log --oneline -3" Enter

# Select window 1 (claude-ai) as default
tmux select-window -t "$SESSION:claude-ai"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Ponyou monitoring session started in tmux       ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Session:   $SESSION                                ║"
echo "║  Windows:   bot-logs | claude-ai | shell         ║"
echo "║                                                   ║"
echo "║  Attach:    tmux attach -t ponyou                ║"
echo "║  Detach:    Ctrl-B then D (from inside tmux)     ║"
echo "║  Switch:    Ctrl-B then [0|1|2]                  ║"
echo "║  Kill:      tmux kill-session -t ponyou          ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

tmux attach -t "$SESSION"
