#!/usr/bin/env bash
set -euo pipefail

mode="${1:-claude}"

case "$mode" in
  claude|codex) ;;
  *)
    printf '%s\n' "Usage: ./launch.sh [claude|codex]" >&2
    exit 1
    ;;
esac

if [ "$mode" = "claude" ] && command -v npm >/dev/null 2>&1; then
  if ! npm run collab:start; then
    printf '\n'
    printf '%s\n' "Warning: npm run collab:start failed; showing prompt anyway." >&2
  else
    printf '\n'
  fi
fi

if [ "$mode" = "claude" ]; then
  cat <<'EOF'
Claude adalah control plane Ponyou.

Ikuti:
1. Baca docs/model-routing.md dan docs/operator-checklist.md.
2. Jalankan npm run collab:start.
3. Jika perlu ide baru, jalankan npm run collab:triage.
4. Jika perlu kerja baru, jalankan npm run collab:upgrade -- ...
5. Delegasikan research ke Gemini.
6. Delegasikan build/testing ke Codex.
7. Submit hasil worker lewat auto_submit_worker_result atau npm run collab:submit -- ....
8. Finalisasi hanya lewat validate_task_policy lalu finalize_task_with_policy.

Aturan inti:
- Claude memutuskan.
- Gemini meneliti.
- Codex membangun dan mengetes.
- MCP collaboration adalah source of truth.
EOF
else
  cat <<'EOF'
Codex adalah build/testing arm untuk Ponyou.

Ikuti:
1. Baca docs/model-routing.md dan docs/codex-escalation.md.
2. Ikuti objective, spec, dan plan dari Claude.
3. Fokus pada implementasi, refactor, test, dan verifikasi.
4. Submit hasil lewat auto_submit_worker_result jika tersedia.
5. Jika submit MCP tidak tersedia, gunakan npm run collab:submit -- ....
6. Jangan mengambil keputusan final produk, risk, atau release.

Aturan inti:
- Codex membangun dan mengetes.
- Claude memutuskan.
- Gemini tidak perlu diikuti untuk eskalasi model.
- MCP collaboration adalah source of truth untuk hasil kerja.
EOF
fi
