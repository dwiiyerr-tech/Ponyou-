#!/usr/bin/env bash
# =============================================================================
# setup-autowork.sh — Set up persistent AutoWork via tmux / nohup / systemd
# =============================================================================
# Usage:
#   ./setup-autowork.sh tmux        Start in a tmux session
#   ./setup-autowork.sh nohup       Start in background via nohup
#   ./setup-autowork.sh systemd     Install and start as systemd service
#   ./setup-autowork.sh stop        Stop whichever method is running
#   ./setup-autowork.sh status      Show running status
#   ./setup-autowork.sh logs        Tail the log file
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")" || exit 1

LOG="claude-autowork.log"
PID_FILE="autowork.pid"
TMUX_SESSION="autowork"
SERVICE_NAME="autowork"
SERVICE_FILE="autowork.service"
SYSTEM_SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*"; }
error() { echo "  ✗ $*" >&2; }
step()  { echo ""; echo "▶ $*"; }

require_cmd() {
  command -v "$1" &>/dev/null || { error "Required command not found: $1. Install it first."; exit 1; }
}

is_tmux_running()    { tmux has-session -t "$TMUX_SESSION" 2>/dev/null; }
is_nohup_running()   { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
is_systemd_running() { systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; }

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_tmux() {
  step "Starting AutoWork in tmux session '$TMUX_SESSION'..."
  require_cmd tmux

  if is_tmux_running; then
    warn "Session '$TMUX_SESSION' already exists."
    echo "     Attach: tmux attach -t $TMUX_SESSION"
    echo "     Stop:   ./setup-autowork.sh stop"
    return
  fi

  tmux new-session -d -s "$TMUX_SESSION" -c "$(pwd)" \
    "bash run-autowork-loop.sh --interval 120 --log $LOG"

  info "tmux session '$TMUX_SESSION' started."
  echo ""
  echo "  Attach to view:    tmux attach -t $TMUX_SESSION"
  echo "  Detach (keep run): Ctrl+B then D"
  echo "  Stop:              ./setup-autowork.sh stop"
  echo "  Logs:              tail -f $LOG"
}

cmd_nohup() {
  step "Starting AutoWork via nohup (background process)..."

  if is_nohup_running; then
    warn "AutoWork already running. PID=$(cat "$PID_FILE")"
    echo "     Stop: ./setup-autowork.sh stop"
    return
  fi

  nohup bash run-autowork-loop.sh --interval 120 --log "$LOG" >> "$LOG" 2>&1 &
  echo $! > "$PID_FILE"
  info "AutoWork started. PID=$(cat "$PID_FILE")"
  echo ""
  echo "  PID file:  $PID_FILE"
  echo "  Stop:      ./setup-autowork.sh stop"
  echo "  Logs:      tail -f $LOG"
}

cmd_systemd() {
  step "Installing AutoWork as systemd service..."
  require_cmd systemctl

  if [[ ! -f "$SERVICE_FILE" ]]; then
    error "autowork.service not found. Run from project directory."
    exit 1
  fi

  # Patch WorkingDirectory and User in service file
  PROJECT_DIR="$(pwd)"
  CURRENT_USER="$(whoami)"
  NODE_BIN="$(dirname "$(command -v node)")"

  # Create a patched copy
  sed \
    -e "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|" \
    -e "s|User=.*|User=$CURRENT_USER|" \
    -e "s|ExecStart=.*run-autowork-loop.sh|ExecStart=$PROJECT_DIR/run-autowork-loop.sh|" \
    -e "s|StandardOutput=append:.*|StandardOutput=append:$PROJECT_DIR/$LOG|" \
    -e "s|StandardError=append:.*|StandardError=append:$PROJECT_DIR/$LOG|" \
    -e "s|Environment=PATH=.*|Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/home/$CURRENT_USER/.local/bin|" \
    "$SERVICE_FILE" > /tmp/autowork-patched.service

  sudo cp /tmp/autowork-patched.service "$SYSTEM_SERVICE_PATH"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl start "$SERVICE_NAME"

  info "Service installed and started."
  echo ""
  echo "  Status:    sudo systemctl status $SERVICE_NAME"
  echo "  Live logs: journalctl -u $SERVICE_NAME -f"
  echo "  Stop:      ./setup-autowork.sh stop"
  echo "  Disable:   sudo systemctl disable $SERVICE_NAME"
}

cmd_stop() {
  step "Stopping AutoWork..."
  STOPPED=false

  if is_tmux_running; then
    tmux kill-session -t "$TMUX_SESSION" && info "tmux session '$TMUX_SESSION' stopped."
    STOPPED=true
  fi

  if is_nohup_running; then
    kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE" && info "Background process stopped."
    STOPPED=true
  elif [[ -f "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
  fi

  if is_systemd_running; then
    sudo systemctl stop "$SERVICE_NAME" && info "systemd service stopped."
    STOPPED=true
  fi

  if [[ "$STOPPED" == "false" ]]; then
    warn "Nothing appears to be running."
  fi
}

cmd_status() {
  step "AutoWork status..."
  echo ""

  # tmux
  if is_tmux_running; then
    info "tmux: RUNNING (session: $TMUX_SESSION)"
  else
    echo "  – tmux: not running"
  fi

  # nohup
  if is_nohup_running; then
    info "nohup: RUNNING (PID=$(cat "$PID_FILE"))"
  else
    echo "  – nohup: not running"
  fi

  # systemd
  if command -v systemctl &>/dev/null; then
    if is_systemd_running; then
      info "systemd: RUNNING"
    else
      echo "  – systemd: not running"
    fi
  fi

  echo ""
  # PR status
  if [[ -f PR_PROGRESS.md ]]; then
    CURRENT_STATUS=$(grep -m1 "^Current status:" PR_PROGRESS.md 2>/dev/null | awk '{print $NF}' || echo "unknown")
    CURRENT_PR=$(grep -m1 "^Current PR:" PR_PROGRESS.md 2>/dev/null | awk '{print $NF}' || echo "none")
    echo "  PR: $CURRENT_PR — $CURRENT_STATUS"
  fi

  echo ""
  echo "  Log: $LOG"
  echo "  Tail: tail -f $LOG"
}

cmd_logs() {
  if [[ ! -f "$LOG" ]]; then
    echo "No log file yet: $LOG"
    exit 0
  fi
  tail -f "$LOG"
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "${1:-help}" in
  tmux)    cmd_tmux ;;
  nohup)   cmd_nohup ;;
  systemd) cmd_systemd ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  help|-h|--help)
    sed -n '/^# USAGE/,/^# ===/{ s/^# \?//; p }' "$0"
    ;;
  *)
    echo "Unknown command: ${1:-}. Use: tmux | nohup | systemd | stop | status | logs"
    exit 1 ;;
esac
