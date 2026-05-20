#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs/supervisor"
WEB_LOG="${LOG_DIR}/dashboard-web.log"
SUPERVISOR_LOG="${LOG_DIR}/dashboard-supervisor.log"
RESTART_DELAY="${RESTART_DELAY_SEC:-5}"
MAX_RESTARTS="${MAX_RESTARTS:-0}"
COUNT=0
WEB_PID=""

mkdir -p "${LOG_DIR}"

log() {
  local line
  line="[$(date -Is)] [WEB-SUPERVISOR] $*"
  printf '%s\n' "$line" | tee -a "${SUPERVISOR_LOG}"
}

build_dashboard() {
  log "Building dashboard bundle"
  (
    cd "${ROOT_DIR}"
    npm run web:build
  ) >>"${SUPERVISOR_LOG}" 2>&1
}

start_dashboard() {
  log "Starting dashboard web server on port ${PORT:-3001}"
  (
    cd "${ROOT_DIR}"
    exec npm run web
  ) >>"${WEB_LOG}" 2>&1 &
  WEB_PID=$!
}

wait_for_dashboard() {
  while true; do
    if [ -z "${WEB_PID}" ]; then
      return 0
    fi

    if ! kill -0 "${WEB_PID}" 2>/dev/null; then
      wait "${WEB_PID}" 2>/dev/null || true
      return 0
    fi

    sleep 2
  done
}

log "Dashboard supervisor booted | root=${ROOT_DIR}"
log "Web log: ${WEB_LOG}"
log "Supervisor log: ${SUPERVISOR_LOG}"

while true; do
  if ! build_dashboard; then
    COUNT=$((COUNT + 1))
    log "Dashboard build failed (attempt ${COUNT}). Sleeping ${RESTART_DELAY}s."
    sleep "${RESTART_DELAY}"
    continue
  fi

  start_dashboard
  set +e
  wait_for_dashboard
  EXIT_CODE=0
  if [ -n "${WEB_PID}" ]; then
    wait "${WEB_PID}"
    EXIT_CODE=$?
  fi
  set -e

  WEB_PID=""
  COUNT=$((COUNT + 1))
  log "Dashboard exited with code ${EXIT_CODE} (restart #${COUNT})"
  if [ "${MAX_RESTARTS}" != "0" ] && [ "${COUNT}" -ge "${MAX_RESTARTS}" ]; then
    log "Reached MAX_RESTARTS=${MAX_RESTARTS}. Dashboard supervisor exiting."
    exit "${EXIT_CODE}"
  fi
  sleep "${RESTART_DELAY}"
done
