#!/usr/bin/env bash
# ponyou — interactive control wizard
set -euo pipefail

AGENT_SVC="ponyou-agent"
LOG_FILE="/home/ubuntu/ponyou/logs/supervisor/agent-demo.log"
DASH_PORT=3000

_status_line() {
  local svc="$1"
  local state
  state=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  case "$state" in
    active)   echo -e "\e[32m● $svc: running\e[0m" ;;
    inactive) echo -e "\e[31m○ $svc: stopped\e[0m" ;;
    *)        echo -e "\e[33m? $svc: $state\e[0m" ;;
  esac
}

_header() {
  clear
  echo -e "\e[1;36m╔══════════════════════════════╗"
  echo -e "║      PONYOU CONTROL          ║"
  echo -e "╚══════════════════════════════╝\e[0m"
  _status_line "$AGENT_SVC"
  echo ""
}

_header

PS3=$'\nPilih opsi: '
options=(
  "Status bot"
  "Start bot"
  "Stop bot"
  "Restart bot"
  "Live log bot"
  "─────────────"
  "Buka dashboard"
  "─────────────"
  "Keluar"
)

select opt in "${options[@]}"; do
  case "$opt" in
    "Status bot")
      systemctl status "$AGENT_SVC" --no-pager | head -20
      ;;
    "Start bot")
      sudo systemctl start "$AGENT_SVC" && echo "Bot started." || echo "Gagal start."
      ;;
    "Stop bot")
      read -rp "Yakin stop bot? (y/N): " confirm
      [[ "$confirm" =~ ^[Yy]$ ]] && sudo systemctl stop "$AGENT_SVC" && echo "Bot stopped." || echo "Dibatalkan."
      ;;
    "Restart bot")
      sudo systemctl restart "$AGENT_SVC" && echo "Bot restarted." || echo "Gagal restart."
      ;;
    "Live log bot")
      echo "Ctrl+C untuk keluar dari log."
      journalctl -u "$AGENT_SVC" -f --no-pager
      ;;
    "Buka dashboard")
      if systemctl is-active "$AGENT_SVC" &>/dev/null; then
        node /home/ubuntu/ponyou/dashboard.js --port "$DASH_PORT" &
        sleep 1
        echo "Dashboard: http://localhost:$DASH_PORT"
      else
        echo "Bot tidak jalan — start dulu."
      fi
      ;;
    "─────────────")
      ;;
    "Keluar")
      echo "Bye."
      exit 0
      ;;
    *)
      echo "Pilihan tidak valid."
      ;;
  esac
  echo ""
  _header
done
