#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-live}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs/supervisor"
AGENT_LOG="${LOG_DIR}/agent-${MODE}.log"
SUPERVISOR_LOG="${LOG_DIR}/supervisor-${MODE}.log"
RESTART_DELAY="${RESTART_DELAY_SEC:-5}"
MAX_RESTARTS="${MAX_RESTARTS:-0}"
SUPERVISOR_STATE_FILE="${ROOT_DIR}/supervisor-state.json"
SUPERVISOR_COMMAND_FILE="${ROOT_DIR}/supervisor-command.json"
COUNT=0
LAST_COMMAND_ID=""
DESIRED_RUNNING=1
AGENT_PID=""

mkdir -p "${LOG_DIR}"

case "${MODE}" in
  live)
    READINESS_CMD=(npm run readiness:live)
    START_CMD=(npm start)
    ;;
  demo)
    READINESS_CMD=(npm run readiness)
    START_CMD=(npm run dev)
    ;;
  *)
    printf '%s\n' "Usage: ./ops/run-24x7.sh [live|demo]" >&2
    exit 1
    ;;
esac

log() {
  local line
  line="[$(date -Is)] [SUPERVISOR] $*"
  printf '%s\n' "$line" | tee -a "${SUPERVISOR_LOG}"
}

write_supervisor_state() {
  node -e "const fs=require('fs');fs.writeFileSync(process.argv[1], JSON.stringify({desiredRunning:process.argv[2]==='1',agentRunning:process.argv[3]==='1',pid:process.argv[4]?Number(process.argv[4]):null,mode:process.argv[5],source:process.argv[6],updatedAt:new Date().toISOString()},null,2)+'\\n');" \
    "${SUPERVISOR_STATE_FILE}" "${DESIRED_RUNNING}" "${1:-0}" "${2:-}" "${MODE}" "${3:-supervisor}" >/dev/null 2>&1
}

run_readiness() {
  if [ "${SKIP_READINESS:-0}" = "1" ]; then
    log "Skipping readiness because SKIP_READINESS=1"
    return 0
  fi

  log "Running readiness: ${READINESS_CMD[*]}"
  (
    cd "${ROOT_DIR}"
    "${READINESS_CMD[@]}"
  ) >>"${SUPERVISOR_LOG}" 2>&1
}

start_agent() {
  log "Starting Ponyou in ${MODE} mode"
  (
    cd "${ROOT_DIR}"
    exec "${START_CMD[@]}"
  ) >>"${AGENT_LOG}" 2>&1 &
  AGENT_PID=$!
  write_supervisor_state 1 "${AGENT_PID}" "spawn"
}

stop_agent() {
  if [ -n "${AGENT_PID}" ] && kill -0 "${AGENT_PID}" 2>/dev/null; then
    log "Stopping agent pid=${AGENT_PID}"
    kill -TERM "${AGENT_PID}" 2>/dev/null || true
    wait "${AGENT_PID}" 2>/dev/null || true
  fi
  AGENT_PID=""
  write_supervisor_state 0 "" "stop"
}

process_supervisor_command() {
  if [ ! -f "${SUPERVISOR_COMMAND_FILE}" ]; then
    return
  fi

  local data id action enabled source
  data=$(node -e "const fs=require('fs');try{const v=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify(v));}catch{process.exit(0)}" "${SUPERVISOR_COMMAND_FILE}" 2>/dev/null || true)
  [ -n "${data}" ] || return

  id=$(node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(String(v.id||''));" "${data}")
  [ -n "${id}" ] || return
  [ "${id}" != "${LAST_COMMAND_ID}" ] || return
  LAST_COMMAND_ID="${id}"

  action=$(node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(String(v.action||''));" "${data}")
  enabled=$(node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(v.enabled===true?'1':v.enabled===false?'0':'');" "${data}")
  source=$(node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(String(v.source||'external'));" "${data}")

  if [ "${action}" = "set_power" ] && [ -n "${enabled}" ]; then
    DESIRED_RUNNING="${enabled}"
    log "Supervisor power command: ${DESIRED_RUNNING} (${source})"
    write_supervisor_state $([ "${DESIRED_RUNNING}" = "1" ] && printf 1 || printf 0) $([ -n "${AGENT_PID}" ] && kill -0 "${AGENT_PID}" 2>/dev/null && printf 1 || printf 0) "${AGENT_PID}" "${source}"
    if [ "${DESIRED_RUNNING}" = "0" ]; then
      stop_agent
    fi
  fi
}

wait_for_agent_or_command() {
  while true; do
    process_supervisor_command

    if [ -z "${AGENT_PID}" ]; then
      return 0
    fi

    if ! kill -0 "${AGENT_PID}" 2>/dev/null; then
      wait "${AGENT_PID}" 2>/dev/null || true
      return 0
    fi

    sleep 2
  done
}

log "Supervisor booted | mode=${MODE} | root=${ROOT_DIR}"
log "Agent log: ${AGENT_LOG}"
log "Supervisor log: ${SUPERVISOR_LOG}"
write_supervisor_state 0 "" "boot"

while true; do
  process_supervisor_command

  if [ "${DESIRED_RUNNING}" != "1" ]; then
    write_supervisor_state 0 "" "idle"
    sleep 2
    continue
  fi

  if ! run_readiness; then
    COUNT=$((COUNT + 1))
    log "Readiness failed before start (attempt ${COUNT}). Sleeping ${RESTART_DELAY}s."
    write_supervisor_state 0 "" "readiness_failed"
    sleep "${RESTART_DELAY}"
    continue
  fi

  start_agent
  set +e
  wait_for_agent_or_command
  EXIT_CODE=0
  if [ -n "${AGENT_PID}" ]; then
    wait "${AGENT_PID}"
    EXIT_CODE=$?
  fi
  set -e

  local_running=0
  if [ -n "${AGENT_PID}" ] && kill -0 "${AGENT_PID}" 2>/dev/null; then
    local_running=1
  fi
  AGENT_PID=""
  write_supervisor_state 0 "" "exit"

  if [ "${DESIRED_RUNNING}" != "1" ]; then
    log "Agent is OFF by supervisor command. Holding process down."
    sleep 2
    continue
  fi

  COUNT=$((COUNT + 1))
  log "Agent exited with code ${EXIT_CODE} (restart #${COUNT})"
  if [ "${MAX_RESTARTS}" != "0" ] && [ "${COUNT}" -ge "${MAX_RESTARTS}" ]; then
    log "Reached MAX_RESTARTS=${MAX_RESTARTS}. Supervisor exiting."
    exit "${EXIT_CODE}"
  fi
  sleep "${RESTART_DELAY}"
done
