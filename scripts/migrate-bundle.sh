#!/usr/bin/env bash
# migrate-bundle.sh — pack everything that lives OUTSIDE git so Ponyou can be
# restored on another machine. The code itself travels via `git clone`; this
# bundle carries secrets, runtime state, the second-brain vault, the MCP
# collab store, cron + PM2 definitions, and Claude Code project memory.
#
# Usage:
#   bash scripts/migrate-bundle.sh            # snapshot while running (prep)
#   pm2 stop ponyou ponyou-dashboard ponyou-llm-proxy && bash scripts/migrate-bundle.sh
#                                             # final cutover (consistent state)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
OUT="$HOME/ponyou-migration-$STAMP.tar.gz"

mkdir -p "$WORK/repo-state" "$WORK/home"

# ── 1. Gitignored runtime + secret files at the repo root ────────────────────
# Everything git ignores EXCEPT caches/build junk. This automatically covers
# new state files added later — no hand-maintained list to go stale.
cd "$REPO"
git status --ignored --porcelain \
  | awk '/^!!/ {print substr($0,4)}' \
  | grep -vE '(^|/)node_modules/|^logs/|\.log$|^dist/|\.venv/|__pycache__/|\.lock$|\.pid$|^web-dashboard/|^\.claude-flow/|^\.swarm/|^agentdb\.rvf|^ruvector\.db|\.bak-' \
  > "$WORK/ignored-list.txt"

rsync -a --files-from="$WORK/ignored-list.txt" "$REPO/" "$WORK/repo-state/"

# ── 2. Out-of-repo pieces ─────────────────────────────────────────────────────
[ -d "$HOME/ponyou-brain" ]  && rsync -a "$HOME/ponyou-brain"  "$WORK/home/"
[ -d "$HOME/.config/gmgn" ]  && rsync -a "$HOME/.config/gmgn"  "$WORK/home/config-gmgn/"

CLAUDE_MEM="$HOME/.claude/projects/-home-ubuntu-ponyou/memory"
[ -d "$CLAUDE_MEM" ] && rsync -a "$CLAUDE_MEM" "$WORK/home/claude-memory/"

crontab -l > "$WORK/crontab.txt" 2>/dev/null || true

# ── 3. PM2 process definitions (regenerate, don't copy ~/.pm2 internals) ─────
cat > "$WORK/ecosystem.config.cjs" <<'EOF'
module.exports = {
  apps: [
    { name: "ponyou",           script: "index.js",              cwd: __dirname + "/..", },
    { name: "ponyou-dashboard", script: "dashboard.js",          cwd: __dirname + "/..", },
    { name: "ponyou-llm-proxy", script: "local-claude-proxy.js", cwd: __dirname + "/..", },
  ],
};
EOF

# ── 4. Restore instructions ───────────────────────────────────────────────────
cat > "$WORK/RESTORE.md" <<'EOF'
# Restore Ponyou di mesin baru

Prasyarat: Linux/macOS/WSL, Node 18+ (teruji 22.x), git, npm. `npm i -g pm2`.

1.  git clone git@github.com:dwiiyerr-tech/Ponyou-.git ponyou && cd ponyou
2.  npm install
3.  Ekstrak bundle ini, lalu dari folder hasil ekstrak:
      rsync -a repo-state/ /path/ke/ponyou/
      rsync -a home/ponyou-brain ~/
      rsync -a home/config-gmgn/gmgn ~/.config/
      # memory Claude Code (sesuaikan path project lokal-mu):
      #   isi home/claude-memory/ → ~/.claude/projects/<slug-path-lokal>/memory/
4.  Verifikasi secrets terbawa: .env, user-config.json, dashboard-token.txt,
    ~/.config/gmgn/private.pem
5.  npm test          # harus hijau penuh sebelum start
6.  npm run readiness # harus OK
7.  pm2 start ecosystem (salin ecosystem.config.cjs dari bundle ke repo, atau
    start manual):
      pm2 start index.js --name ponyou
      pm2 start dashboard.js --name ponyou-dashboard
      pm2 start local-claude-proxy.js --name ponyou-llm-proxy
      pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 10M \
        && pm2 set pm2-logrotate:retain 14
      pm2 save && pm2 startup   # ikuti instruksi yang dicetak
8.  Crontab (lihat crontab.txt — sesuaikan path):
      17 * * * * /usr/bin/node /path/ke/ponyou/scripts/refresh-brain.js >> ~/ponyou-brain/.refresh.log 2>&1
9.  Dashboard: cd dashboard && npm run build (wajib setelah clone).
10. CATATAN TIMEZONE: cron harian sudah di-pin UTC di kode (scheduleUtc),
    jadi timezone mesin baru bebas. Interval-cron tidak terpengaruh.
11. Verifikasi hidup: pm2 logs ponyou | banner "Opt-in features" semua ON,
    watchdog "13/13 alive" dalam 15 menit, ~/ponyou-brain/00-Overview/
    _engine-reality.md ter-update dalam 5 menit.

PENTING saat cutover final: matikan bot di server LAMA dulu
(pm2 stop ponyou ponyou-dashboard ponyou-llm-proxy && pm2 save), jalankan ulang
migrate-bundle.sh agar state konsisten, baru start di mesin baru. Jangan
jalankan dua instance pada Telegram bot token yang sama (polling conflict).
EOF

cp "$WORK/ignored-list.txt" "$WORK/MANIFEST.txt"

tar -czf "$OUT" -C "$WORK" .
rm -rf "$WORK"
echo "Bundle: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Transfer dgn scp/rsync, JANGAN upload ke layanan publik — berisi secrets."
