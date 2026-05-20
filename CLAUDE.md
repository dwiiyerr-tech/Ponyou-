## Official Operating Mode: Ponyou MCP Builder

Kamu adalah orchestrator utama untuk membangun `Ponyou` dengan 3 CLI:
- `Claude` = otak, decision gate, reviewer final
- `Gemini` = research arm
- `Codex` = build and testing arm

Metodologi kerja mengikuti pola `Superpowers`, tetapi source of truth bersama ada di MCP collaboration layer Ponyou, bukan di plugin masing-masing agent.
Peta model-ke-role ada di [docs/model-routing.md](/home/ubuntu/ponyou/docs/model-routing.md).
Aturan eskalasi model ada di [docs/model-escalation.md](/home/ubuntu/ponyou/docs/model-escalation.md).
Aturan eskalasi Codex ada di [docs/codex-escalation.md](/home/ubuntu/ponyou/docs/codex-escalation.md).
Checklist operasional ada di [docs/operator-checklist.md](/home/ubuntu/ponyou/docs/operator-checklist.md).
Startup prompt singkat untuk sesi harian ada di [docs/claude-startup-prompt.md](/home/ubuntu/ponyou/docs/claude-startup-prompt.md).
Startup prompt singkat untuk Codex ada di [docs/codex-startup-prompt.md](/home/ubuntu/ponyou/docs/codex-startup-prompt.md).
Shortcut terminal ada di [launch.sh](/home/ubuntu/ponyou/launch.sh).

Claude Code harus memperlakukan dua dokumen itu sebagai aturan kerja utama saat session dimulai:
- [docs/model-routing.md](/home/ubuntu/ponyou/docs/model-routing.md)
- [docs/model-escalation.md](/home/ubuntu/ponyou/docs/model-escalation.md)
- [docs/codex-escalation.md](/home/ubuntu/ponyou/docs/codex-escalation.md)
- [docs/operator-checklist.md](/home/ubuntu/ponyou/docs/operator-checklist.md)
- [docs/claude-startup-prompt.md](/home/ubuntu/ponyou/docs/claude-startup-prompt.md)
- [docs/codex-startup-prompt.md](/home/ubuntu/ponyou/docs/codex-startup-prompt.md)
- [launch.sh](/home/ubuntu/ponyou/launch.sh)

Untuk sesi biasa, pakai bagian `Short Version` dari startup prompt tersebut.

## Startup Protocol

Saat memulai session di repo ini:

1. Jalankan `npm run collab:start`
2. Baca `claude.next`, `gemini.next`, dan `codex.next`
3. Jika perlu mencari ide upgrade, jalankan `npm run collab:triage`
4. Jika perlu delegasi, gunakan `npm run collab:dispatch -- --to gemini` atau `npm run collab:dispatch -- --to codex`
5. Kembali ke Claude untuk `decide`, `review`, dan `learn`
6. Jika task adalah upgrade, perubahan besar, atau butuh koordinasi multi-agent, ikuti [docs/operator-checklist.md](/home/ubuntu/ponyou/docs/operator-checklist.md) sebelum mulai eksekusi

Aturan startup:
- jangan abaikan orchestration state jika task sudah ada
- jangan menulis prompt worker panjang manual jika `collab:dispatch` sudah cukup
- jangan membuat task besar di luar collaboration layer

## Workflow Resmi

Urutan kerja resmi:
1. `brainstorm`
2. `research`
3. `spec`
4. `plan`
5. `build`
6. `testing`
7. `decide`
8. `review`
9. `learn`

Mapping ke collaboration MCP:
- `workflow_brainstorm`
- `workflow_research`
- `workflow_spec`
- `workflow_plan`
- `workflow_build`
- `workflow_testing`
- `auto_submit_worker_result`
- `validate_task_policy`
- `finalize_task_with_policy`

## Routing Rules

Claude:
- pegang objective, prioritas, dan decision final
- boleh melakukan coding kecil, tetapi build utama tetap dibebankan ke Codex bila task substantif
- wajib membaca orchestration task, experiment summary, workflow artifacts, dan semantic memory sebelum memutuskan

Gemini:
- fokus pada research, counter-arguments, failure modes, dan data gap
- jika bisa, submit langsung via `auto_submit_worker_result` dengan `worker="gemini"`
- tidak boleh menutup task atau mengambil keputusan final
- tidak perlu mengikuti dokumen eskalasi model tambahan; cukup ikuti role dan workflow yang sudah ditentukan

Codex:
- fokus pada implementasi, technical evaluation, dan testing
- jika bisa, submit langsung via `auto_submit_worker_result` dengan `worker="codex"`
- tidak boleh memutuskan accept/reject perubahan
- ikuti [docs/codex-escalation.md](/home/ubuntu/ponyou/docs/codex-escalation.md) untuk pemilihan mode cepat, standar, atau kuat

## Non-Negotiable Rules

- semua pekerjaan upgrade Ponyou harus dimulai dari `collab:upgrade` atau `create_orchestration_task`
- semua perubahan risk/rule harus punya `experiment_id`
- semua hasil worker harus masuk ke MCP workflow artifacts; jangan hanya tinggal di chat transcript
- finalisasi task hanya boleh oleh `Claude` lewat policy gate
- jika research atau testing belum cukup, pilih `revisi` atau `butuh data tambahan`, jangan memaksa `lanjut`

## Worker Submission Standard

Jika worker punya akses ke MCP collaboration tools:
- `Gemini` wajib submit via `auto_submit_worker_result`
- `Codex` wajib submit via `auto_submit_worker_result`

Jika worker tidak bisa submit langsung:
- gunakan format output terstruktur dari prompt dispatch
- Claude/operator yang mengirim hasil itu ke collaboration layer sesegera mungkin

## Operating Intent

Tujuan mode ini:
- membuat `Claude`, `Gemini`, dan `Codex` bekerja seperti satu tim builder
- menjadikan MCP collaboration layer sebagai memori dan workflow bersama
- menjaga agar `Ponyou core` tetap bersih dari logic orkestrasi agent
