#!/usr/bin/env bash
# Ponyou status line — white horizontal bar only

STATE_FILE="${PONYOU_STATE:-$HOME/ponyou/.ponyou-state.json}"

if [[ -f "$STATE_FILE" ]]; then
  MODE=$(node -e "try{const s=JSON.parse(require('fs').readFileSync('$STATE_FILE'));process.stdout.write(s.mode||'demo')}catch(e){process.stdout.write('demo')}" 2>/dev/null)
  BAL=$(node -e  "try{const s=JSON.parse(require('fs').readFileSync('$STATE_FILE'));process.stdout.write(s.balance?.toFixed(2)||'0.00')}catch(e){process.stdout.write('0.00')}" 2>/dev/null)
  POS=$(node -e  "try{const s=JSON.parse(require('fs').readFileSync('$STATE_FILE'));process.stdout.write(String(s.openPositions||0))}catch(e){process.stdout.write('0')}" 2>/dev/null)
  PNL=$(node -e  "try{const s=JSON.parse(require('fs').readFileSync('$STATE_FILE'));const p=s.dailyPnl||0;process.stdout.write((p>=0?'+':'')+p.toFixed(2))}catch(e){process.stdout.write('+0.00')}" 2>/dev/null)
  printf '\033[97m─── PONYOU  mode:%-5s  bal:%-7s SOL  pos:%-3s  pnl:%-9s ───\033[0m' \
    "$MODE" "$BAL" "$POS" "$PNL SOL"
else
  printf '\033[97m─── PONYOU ─────────────────────────────────────────────────────\033[0m'
fi
