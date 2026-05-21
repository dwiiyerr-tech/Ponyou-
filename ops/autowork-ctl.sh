#!/usr/bin/env bash
# =============================================================================
# autowork-ctl.sh — Manage Ponyou AutoWork daemon (24x7 Claude PR worker)
# =============================================================================
# USAGE
#   ./ops/autowork-ctl.sh <command>
#
# COMMANDS
#   enable        Install + enable systemd service, start now
#   disable       Stop + disable systemd service
#   start         Start without enabling on boot
#   stop          Stop daemon (restarts on next boot if enabled)
#   restart       Restart daemon
#   status        Show service status + last 20 log lines
#   logs          Follow live logs (Ctrl-C to exit)
#   logs-tail N   Show last N log lines (default: 50)
#   uninstall     Stop, disable, remove service file
# =============================================================================

set -euo pipefail

SERVICE="ponyou-autowork"
SERVICE_FILE="/etc/systemd/system/${SERVICE}.service"
SRC_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/autowork.service"
LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/logs/autowork"
DAEMON_LOG="${LOG_DIR}/daemon.log"

die() { echo "ERROR: $*" >&2; exit 1; }
need_sudo() { [[ $EUID -eq 0 ]] || die "Run with sudo: sudo ./ops/autowork-ctl.sh $1"; }

cmd_enable() {
  need_sudo enable
  mkdir -p "${LOG_DIR}"
  cp "${SRC_FILE}" "${SERVICE_FILE}"
  systemctl daemon-reload
  systemctl enable --now "${SERVICE}"
  echo "AutoWork daemon enabled and started."
  echo "View logs: sudo ./ops/autowork-ctl.sh logs"
}

cmd_disable() {
  need_sudo disable
  systemctl disable --now "${SERVICE}" 2>/dev/null || true
  echo "AutoWork daemon stopped and disabled."
}

cmd_start() {
  need_sudo start
  systemctl start "${SERVICE}"
  echo "AutoWork daemon started (not enabled on boot — use enable for that)."
}

cmd_stop() {
  need_sudo stop
  systemctl stop "${SERVICE}"
  echo "AutoWork daemon stopped."
}

cmd_restart() {
  need_sudo restart
  systemctl restart "${SERVICE}"
  echo "AutoWork daemon restarted."
}

cmd_status() {
  echo "=== systemd status ==="
  systemctl status "${SERVICE}" --no-pager || true
  echo ""
  echo "=== last 20 daemon log lines ==="
  if [[ -f "${DAEMON_LOG}" ]]; then
    tail -20 "${DAEMON_LOG}"
  else
    echo "(no log file yet — daemon may not have started)"
    echo "Use: journalctl -u ${SERVICE} -n 20"
  fi
}

cmd_logs() {
  echo "Following live logs (Ctrl-C to stop)..."
  if [[ -f "${DAEMON_LOG}" ]]; then
    tail -f "${DAEMON_LOG}"
  else
    journalctl -u "${SERVICE}" -f
  fi
}

cmd_logs_tail() {
  local n="${1:-50}"
  if [[ -f "${DAEMON_LOG}" ]]; then
    tail -"${n}" "${DAEMON_LOG}"
  else
    journalctl -u "${SERVICE}" -n "${n}" --no-pager
  fi
}

cmd_uninstall() {
  need_sudo uninstall
  systemctl disable --now "${SERVICE}" 2>/dev/null || true
  rm -f "${SERVICE_FILE}"
  systemctl daemon-reload
  echo "AutoWork daemon uninstalled."
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
COMMAND="${1:-status}"
case "${COMMAND}" in
  enable)     cmd_enable ;;
  disable)    cmd_disable ;;
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  restart)    cmd_restart ;;
  status)     cmd_status ;;
  logs)       cmd_logs ;;
  logs-tail)  cmd_logs_tail "${2:-50}" ;;
  uninstall)  cmd_uninstall ;;
  *)
    echo "Unknown command: ${COMMAND}"
    echo "Run: ./ops/autowork-ctl.sh --help"
    exit 1
    ;;
esac
