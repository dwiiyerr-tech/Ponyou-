# Agent Collaboration

Tujuan dokumen ini adalah membuat `Codex CLI`, `Gemini CLI`, dan `Claude CLI` bekerja sebagai tim builder untuk `Ponyou` tanpa mencampur layer kolaborasi ke core bot.

## Boundary

- `Ponyou core`:
  - runtime trading
  - market/state tools
  - risk/execution logic bot
- `Collaboration layer`:
  - MCP server: [collaboration-mcp-server.js](/home/ubuntu/ponyou/collaboration-mcp-server.js)
  - implementation: [infra/agent-collab](/home/ubuntu/ponyou/infra/agent-collab)
  - purpose: shared memory, experiments, orchestration, handoff

## Official Operating Mode

Mode resmi builder `Ponyou`:
- `Superpowers` dipakai sebagai metodologi kerja
- `MCP collaboration layer` dipakai sebagai source of truth bersama
- `Ponyou core` tetap menjadi target sistem yang dibangun, bukan tempat orkestrasi 3 agent
- peta model-ke-role ada di [model-routing.md](/home/ubuntu/ponyou/docs/model-routing.md)
- checklist operator ada di [operator-checklist.md](/home/ubuntu/ponyou/docs/operator-checklist.md)

Peran resmi:
- `Claude` = chief architect, objective owner, decision gate
- `Gemini` = research arm, counter-argument arm
- `Codex` = build arm, testing arm

Prinsip resmi:
- semua pekerjaan upgrade besar harus masuk ke orchestration + experiment
- semua hasil worker harus masuk ke workflow artifacts
- semua penutupan task harus lewat policy gate Claude
- transcript chat bukan sumber kebenaran; collaboration layer adalah sumber kebenaran

Aturan utama:
- jangan menambahkan logic kolaborasi ke loop trading utama kecuali memang disetujui
- semua kerja lintas CLI lewat MCP collaboration server
- `mcp-server.js` Ponyou tetap untuk data/runtime bot

## Roles

- `Claude`
  - otak utama sistem
  - pemilik objective dan prioritas
  - pengambil keputusan akhir
  - reviewer final untuk eksperimen, perubahan code, dan arah risk
- `Gemini`
  - riset market
  - counter-arguments
  - hypothesis generation
  - second opinion untuk Claude
- `Codex`
  - implementasi
  - refactor
  - test
  - tangan eksekusi teknis untuk Claude

## Main Tools

Tool collaboration memory:
- `collab_log_entry`
- `collab_recent_entries`
- `collab_search_entries`
- `collab_get_handoffs`

Tool experiment:
- `create_experiment`
- `update_experiment_status`
- `record_experiment_run`
- `list_experiments`
- `get_experiment_summary`
- `get_experiment_overview`

Tool semantic retrieval:
- `add_semantic_memory`
- `search_semantic_memory`
- `get_recent_semantic_memory`
- `index_experiment_memory`

Tool orchestration:
- `create_orchestration_task`
- `advance_orchestration_task`
- `add_orchestration_note`
- `get_orchestration_task`
- `list_orchestration_tasks`
- `get_open_handoffs`

Tool workflow bridge:
- `workflow_brainstorm`
- `workflow_research`
- `workflow_spec`
- `workflow_plan`
- `workflow_build`
- `workflow_testing`
- `auto_submit_worker_result`
- `get_workflow_artifacts`
- `validate_task_policy`
- `finalize_task_with_policy`

Command fallback:
- `collab:submit`

## Standard Flow

Metodologi resmi:
1. `brainstorm`
2. `research`
3. `spec`
4. `plan`
5. `build`
6. `testing`
7. `decide`
8. `review`
9. `learn`

State orchestration yang dipakai sistem saat ini:
1. `research`
2. `evaluate`
3. `decide`
4. `execute`
5. `review`
6. `learn`

Pemetaan praktis:
- `brainstorm` -> artifact awal via `workflow_brainstorm`
- `research` -> stage `research`
- `spec` dan `plan` -> artifact yang biasanya dibuat saat task masih dalam jalur menuju `evaluate`
- `build` dan `testing` -> umumnya terjadi saat stage `evaluate` atau `execute`
- `decide`, `review`, `learn` -> mengikuti stage orchestration secara langsung

Owner default orchestration:
- `research` -> `gemini`
- `evaluate` -> `codex`
- `decide` -> `claude`
- `execute` -> `codex`
- `review` -> `claude`
- `learn` -> `claude`

## Working Rules

- Semua task besar mulai dari `create_orchestration_task`
- Untuk upgrade fitur atau rule baru, lebih baik mulai dari `collab:upgrade`
- `Claude` tetap jadi pemilik arah, meski task sedang ada di `research` atau `evaluate`
- Semua perubahan rule/risk baru harus punya `experiment_id`
- Semua hasil penting yang reusable harus masuk ke `semantic memory`
- Semua handoff harus menyertakan note singkat yang bisa ditindaklanjuti
- Jangan simpan log mentah panjang ke semantic memory; simpan ringkasan yang bisa dipakai ulang
- Worker sebaiknya memakai `auto_submit_worker_result` agar hasilnya langsung masuk ke artifact + orchestration tanpa copy manual beberapa tool
- Jika worker tidak bisa memanggil MCP tool langsung, gunakan `npm run collab:submit -- ...` sebagai fallback operator
- Jangan anggap task selesai hanya karena worker menjawab di chat; cek artifact dan policy gate

## Minimal Patterns

### 1. Research -> Evaluate

Gemini:
- supply riset dan kontra-argumen untuk Claude
- cari memory serupa via `search_semantic_memory`
- submit lewat `auto_submit_worker_result`
- sistem akan menulis artifact riset dan advance ke `evaluate`
- fallback operator:
```bash
npm run collab:submit -- \
  --task-id 12 \
  --worker gemini \
  --findings "holder structure stable,volume still healthy" \
  --counter-arguments "rotation risk rising" \
  --unknowns "need deployer cross-check" \
  --confidence 0.68 \
  --recommendation "Proceed to technical evaluation."
```

Codex:
- ambil handoff teknis via `get_open_handoffs`
- cek context task via `get_orchestration_task`
- implement atau evaluasi teknis
- submit lewat `auto_submit_worker_result`
- sistem akan menulis artifact build/testing dan advance ke `decide` atau `review` sesuai stage aktif
- fallback operator:
```bash
npm run collab:submit -- \
  --task-id 12 \
  --worker codex \
  --technical-plan-or-change "Added route-aware selector behind feature flag" \
  --files-or-modules-affected "tools/executor.js,execution-quality-memory.js" \
  --verification "unit tests updated,dry run checked" \
  --risks "route quality may degrade under congestion" \
  --questions-for-claude "Should rollout remain HOT-only first" \
  --test-plan "run route suite,run dry mode" \
  --test-results "route suite passed,dry mode passed" \
  --coverage-notes "no live order path exercised"
```

Claude:
- buat atau setujui objective
- baca task + semantic context + experiment context
- putuskan lanjut, revisi, atau stop
- tetap menjadi satu-satunya decision gate

### 2. Formal Experiment

1. Buat eksperimen dengan `create_experiment`
2. Hubungkan task orchestration ke `experiment_id`
3. Catat run baseline/candidate dengan `record_experiment_run`
4. Index hasil penting ke semantic memory dengan `index_experiment_memory`
5. Claude memakai `get_experiment_summary` untuk keputusan promote/reject
6. Gemini dan Codex hanya memberi input, bukan keputusan final

### 2b. Brainstorming

Sebelum research atau spec lebih detail, `Claude` bisa menulis artifact brainstorming:
- `idea`
- `goals`
- `non_goals`
- `alternatives`
- `open_questions`

Pakai:
- `workflow_brainstorm`

Artifact ini tidak mengubah stage task, tapi memberi jejak desain awal yang bisa dibaca ulang oleh `Gemini` dan `Codex`.

### 3. Postmortem

Setelah hasil penting:
- buat entry semantic memory bertipe `postmortem`, `risk-note`, atau `experiment`
- isi:
  - apa yang terjadi
  - kenapa terjadi
  - sinyal yang seharusnya dikenali
  - aturan yang berubah atau tetap

## Recommended Entry Shapes

`collab_log_entry`:
- `type`: `idea|plan|progress|evaluation|decision|handoff|risk|note`
- `summary`: satu kalimat yang action-oriented
- `details`: singkat, bukan transcript penuh

`add_semantic_memory`:
- `type`: `postmortem|experiment|regime-note|risk-note|wallet-note`
- `title`: deskriptif dan searchable
- `summary`: hasil inti
- `tags`: narrative/risk/topic

## Example Run

Contoh task:
- objective: `Evaluate whether tighter rug filter should become the new default probe gate`

Flow:
1. Gemini: `create_experiment`
2. Claude atau operator: `create_orchestration_task`
3. Gemini: research + `advance_orchestration_task(... evaluate ...)`
4. Codex: implement/test branch candidate
5. Codex: `add_orchestration_note`
6. Codex: `advance_orchestration_task(... decide ...)`
7. Claude: review experiment summary
8. Claude: if accepted, log `decision`
9. Gemini/Claude: `index_experiment_memory`
10. Gemini: `advance_orchestration_task(... learn ...)`

## Bootstrap Command

Untuk membuat eksperimen + orchestration task sekaligus:

```bash
npm run collab:bootstrap -- \
  --title "Tighter rug gate for probes" \
  --objective "Evaluate whether lower rug threshold improves probe quality" \
  --hypothesis "Lower threshold reduces false positives in HOT regimes" \
  --baseline-rule "rug_score<35" \
  --candidate-rule "rug_score<28" \
  --owner claude \
  --tags risk,probe \
  --symbol ABC \
  --market-condition HOT \
  --narrative AI \
  --tier MICRO_CAP
```

Output akan berisi:
- `experiment_id`
- `task_id`
- stage awal task

Script:
- [infra/agent-collab/bootstrap-task.js](/home/ubuntu/ponyou/infra/agent-collab/bootstrap-task.js)

## Upgrade Command

Untuk memulai upgrade Ponyou dengan experiment + task + spec skeleton + plan skeleton:

```bash
npm run collab:upgrade -- \
  --title "Upgrade execution route selection" \
  --objective "Improve execution quality under HOT market conditions" \
  --hypothesis "Route-aware selection improves fill quality and reduces slippage" \
  --baseline-rule "current route selection" \
  --candidate-rule "route-aware split preference in HOT markets" \
  --problem-statement "Current route choice ignores market condition" \
  --success-criteria "quality score up,no slippage regression" \
  --constraints "do not change risk gate,keep feature-flagged" \
  --acceptance-checks "tests pass,dry run clean" \
  --milestones "measure baseline,implement route logic,run tests" \
  --risks "route instability,slippage regression" \
  --rollout-strategy "feature flag then staged rollout"
```

Output akan berisi:
- `experiment_id`
- `task_id`
- `spec_id`
- `plan_id`

Script:
- [infra/agent-collab/collab-upgrade.js](/home/ubuntu/ponyou/infra/agent-collab/collab-upgrade.js)

## Role Prompt Templates

Template prompt siap pakai:
- [infra/agent-collab/prompts/claude-chief.md](/home/ubuntu/ponyou/infra/agent-collab/prompts/claude-chief.md)
- [infra/agent-collab/prompts/gemini-researcher.md](/home/ubuntu/ponyou/infra/agent-collab/prompts/gemini-researcher.md)
- [infra/agent-collab/prompts/codex-executor.md](/home/ubuntu/ponyou/infra/agent-collab/prompts/codex-executor.md)

Gunakan model berikut:
- `Claude` = chief architect / chief decision maker
- `Gemini` = research arm / counter-argument arm
- `Codex` = execution arm / technical implementation arm

## Claude Remote Control

Gunakan `Claude Code` sebagai meja komando utama dengan command berikut:

```bash
npm run collab:status
npm run collab:handoffs -- --owner claude
npm run collab:next -- --owner claude
npm run collab:next -- --owner gemini -- --for gemini
npm run collab:next -- --owner codex -- --for codex
npm run collab:dispatch -- --to gemini
npm run collab:dispatch -- --to codex
npm run collab:start
npm run collab:triage
```

Fungsi:
- `collab:status`
  - ringkasan task dan eksperimen aktif
- `collab:handoffs`
  - daftar handoff terbuka untuk owner tertentu
- `collab:next`
  - satu task berikutnya yang paling relevan untuk owner tersebut, lengkap dengan suggested action
  - jika dipakai dengan `--for gemini` atau `--for codex`, output juga berisi prompt siap kirim ke worker
- `collab:dispatch`
  - cetak prompt worker saja tanpa JSON tambahan
  - paling hemat token untuk Claude sebagai controller
- `collab:start`
  - startup summary ringkas untuk Claude
  - menampilkan status global, next task Claude, dan next task worker bila ada
- `collab:triage`
  - mencari ide upgrade Ponyou dari experiment, semantic memory, dan task yang macet
  - cocok dipakai Claude untuk memilih fokus upgrade berikutnya

Model kerja:
- `Claude` membaca `collab:status`
- `Claude` mengambil `collab:next`
- `Claude` memberi instruksi ke `Gemini` atau `Codex`
- setelah mereka selesai, `Claude` kembali ke stage `decide`, `review`, dan `learn`

Contoh:

```bash
npm run collab:next -- --owner gemini -- --for gemini
npm run collab:next -- --owner codex -- --for codex
npm run collab:dispatch -- --to gemini
npm run collab:dispatch -- --to codex
```

Claude dapat mengambil field `prompt` dari output JSON lalu mengirimkannya langsung ke worker terkait.
Atau, untuk alur paling hemat, Claude cukup memakai `collab:dispatch` dan mengirim output plain text itu langsung.

Untuk startup session Claude yang paling praktis:

```bash
npm run collab:start
```

Lalu:
- lihat `claude.next`
- jika perlu delegasi, ambil prompt worker dari `gemini.next.prompt` atau `codex.next.prompt`

Untuk mencari ide pengembangan Ponyou:

```bash
npm run collab:triage
```

Pakai output ini untuk:
- memilih upgrade minggu ini
- memutuskan eksperimen mana yang perlu diperpanjang
- mencari regresi yang harus segera dibenahi

## File Map

- collaboration server:
  - [collaboration-mcp-server.js](/home/ubuntu/ponyou/collaboration-mcp-server.js)
- collab implementation:
  - [infra/agent-collab/experiment-tracker.js](/home/ubuntu/ponyou/infra/agent-collab/experiment-tracker.js)
  - [infra/agent-collab/semantic-memory.js](/home/ubuntu/ponyou/infra/agent-collab/semantic-memory.js)
  - [infra/agent-collab/agent-orchestrator.js](/home/ubuntu/ponyou/infra/agent-collab/agent-orchestrator.js)
  - [infra/agent-collab/prompts/README.md](/home/ubuntu/ponyou/infra/agent-collab/prompts/README.md)
- core Ponyou MCP:
  - [mcp-server.js](/home/ubuntu/ponyou/mcp-server.js)

## Non-Goals

- collaboration layer tidak mengeksekusi trade sendiri
- collaboration layer tidak mengubah runtime core otomatis
- collaboration layer bukan pengganti risk engine Ponyou

Ia hanya menjadi workspace koordinasi untuk 3 CLI saat membangun dan mengevaluasi Ponyou.
