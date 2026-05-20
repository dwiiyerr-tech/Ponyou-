# Model Routing

Dokumen ini menetapkan peta model-ke-role untuk workflow `Ponyou` yang memakai `Claude`, `Gemini`, dan `Codex` sebagai tim builder.

Catatan:
- `MCP` tidak memilih model.
- `MCP` hanya menyatukan task, memory, artifact, handoff, dan policy gate.
- Pilihan model tetap ada di control plane masing-masing CLI.
- Jika sebuah CLI tidak mendukung pemilihan model secara eksplisit, pakai role workflow yang sudah ditentukan di sini.

## Prinsip Dasar

- `Claude` memegang keputusan akhir.
- `Gemini` dipakai saat butuh eksplorasi, riset, dan kontra-argumen.
- `Codex` dipakai saat butuh perubahan teknis, implementasi, dan testing.
- Jangan pakai model yang terlalu berat untuk pekerjaan yang bisa diselesaikan oleh worker spesifik.

## Peta Role

### `brainstorm`
- Tujuan: ide awal, alternatif, ruang lingkup
- Model utama: `Claude`
- Model pendukung: `Gemini` jika butuh variasi ide
- Rekomendasi keluarga model: `Haiku` atau `Sonnet` untuk ide ringan, `Opus` bila problem masih kabur dan butuh sintesis besar

### `research`
- Tujuan: data terbaru, hipotesis, kontra-argumen, failure modes
- Model utama: `Gemini`
- Model pendukung: `Claude` untuk sintesis
- Rekomendasi keluarga model: model research yang cepat bila query sempit, model lebih kuat bila perlu banyak sumber dan argumentasi

### `spec`
- Tujuan: problem statement, success criteria, acceptance checks
- Model utama: `Claude`
- Model pendukung: `Gemini` untuk sanity check
- Rekomendasi keluarga model: `Sonnet` untuk mayoritas kasus, `Opus` jika spec besar dan banyak tradeoff

### `plan`
- Tujuan: milestones, rollout strategy, risk decomposition
- Model utama: `Claude`
- Model pendukung: `Codex` untuk feasibility teknis
- Rekomendasi keluarga model: `Sonnet` biasanya cukup, `Opus` jika plan perlu sintesis lintas banyak constraint

### `build`
- Tujuan: implementasi, refactor, modul baru, integrasi
- Model utama: `Codex`
- Model pendukung: `Claude` untuk review arah, `Gemini` jika ada area riset yang belum jelas
- Rekomendasi keluarga model: model coding yang efisien untuk tugas rutin, model lebih kuat untuk refactor besar atau debugging kompleks
- Ikuti [codex-escalation.md](/home/ubuntu/ponyou/docs/codex-escalation.md) untuk memilih mode cepat, standar, atau kuat

### `testing`
- Tujuan: unit test, regression test, dry run, bug hunt
- Model utama: `Codex`
- Model pendukung: `Claude` untuk menilai kualitas verifikasi
- Rekomendasi keluarga model: model efisien untuk test harness dan reproduksi bug, model lebih kuat untuk debugging lintas modul
- Ikuti [codex-escalation.md](/home/ubuntu/ponyou/docs/codex-escalation.md) untuk memilih mode cepat, standar, atau kuat

### `decide`
- Tujuan: accept, revise, reject, or needs more data
- Model utama: `Claude`
- Model pendukung: `Gemini` dan `Codex` sebagai evidence providers
- Rekomendasi keluarga model: `Opus` atau model paling kuat yang tersedia untuk keputusan final

### `review`
- Tujuan: final quality gate, residual risk, release readiness
- Model utama: `Claude`
- Model pendukung: `Codex` untuk detail teknis
- Rekomendasi keluarga model: `Opus` untuk review kritis, `Sonnet` untuk review rutin

### `learn`
- Tujuan: postmortem, lessons, memory indexing
- Model utama: `Claude`
- Model pendukung: `Gemini` untuk pattern search
- Rekomendasi keluarga model: `Sonnet` cukup untuk indexing lessons, `Opus` jika postmortem multi-faktor dan mahal salahnya

## Workflow Shortcut

Gunakan aturan cepat ini:

- `Claude` = `brainstorm`, `spec`, `plan`, `decide`, `review`, `learn`
- `Gemini` = `research`
- `Codex` = `build`, `testing`

## Token Discipline

- Pakai model paling ringan yang masih valid untuk stage tersebut.
- Jangan minta semua model mengerjakan hal yang sama.
- Jika hasil worker cukup jelas, submit langsung lewat `auto_submit_worker_result`.
- Jika worker gagal submit, pakai `npm run collab:submit -- ...`.

## Example Model Allocation

Contoh alokasi yang sehat:

- `brainstorm`: `Claude Sonnet`
- `research`: `Gemini` model kuat yang tersedia
- `spec`: `Claude Sonnet`
- `plan`: `Claude Sonnet`
- `build`: `Codex` model coding yang efisien
- `testing`: `Codex` model efisien, naik ke model kuat saat bug sulit direproduksi
- `decide`: `Claude Opus`
- `review`: `Claude Opus`
- `learn`: `Claude Sonnet` atau `Opus` jika postmortem besar

Prinsip:
- jangan pakai model paling mahal untuk semua stage
- naikkan model hanya saat konteks, risiko, atau kompleksitas membenarkan biaya

## Task To Model To Command

| Task Type | Role | Model Recommendation | Command / Action |
|-----------|------|----------------------|------------------|
| Ide awal / framing | Claude | Sonnet, Opus jika masih kabur | `npm run collab:start` lalu `workflow_brainstorm` |
| Riset market / narasi | Gemini | Model research yang paling kuat tersedia | `npm run collab:dispatch -- --to gemini` |
| Spec / acceptance criteria | Claude | Sonnet, Opus untuk spec kompleks | `workflow_spec` |
| Planning / rollout | Claude | Sonnet | `workflow_plan` |
| Implementasi / refactor | Codex | Model coding efisien, naikkan saat refactor besar | `npm run collab:dispatch -- --to codex` |
| Testing / bug hunt | Codex | Model coding efisien, naikkan saat bug sulit | `workflow_testing` atau `collab:submit` |
| Keputusan final | Claude | Opus bila risiko tinggi, Sonnet untuk keputusan rutin | `validate_task_policy` lalu `finalize_task_with_policy` |
| Review / release gate | Claude | Opus untuk review kritis | `validate_task_policy` |
| Postmortem / memory | Claude | Sonnet, Opus jika insiden besar | `index_experiment_memory` |

## When To Use Mini vs Full

Gunakan model kecil atau efisien ketika:
- task satu langkah
- output yang dibutuhkan pendek
- bug sudah terlokalisasi
- riset hanya butuh satu arah pencarian
- perubahan kode kecil dan aman

Gunakan model penuh atau lebih kuat ketika:
- spec masih ambigu
- ada banyak tradeoff lintas modul
- review menyangkut risk atau release
- bug tidak bisa direproduksi cepat
- keputusan punya dampak mahal jika salah

Rule of thumb:
- `mini` atau model ringan untuk throughput
- `Sonnet` untuk mayoritas kerja
- `Opus` atau model paling kuat untuk keputusan, review, dan debugging sulit

## Practical Examples

### Contoh 1
Masalah: ingin tahu apakah narasi tertentu masih kuat.

- `Gemini` melakukan `research`
- `Claude` memutuskan apakah ada eksperimen lanjut

### Contoh 2
Masalah: ingin menambah route-aware logic.

- `Claude` menulis `spec` dan `plan`
- `Codex` membangun dan mengetes
- `Claude` menutup keputusan

### Contoh 3
Masalah: ingin evaluasi ide upgrade baru.

- `Claude` melakukan `brainstorm`
- `Gemini` melakukan `research`
- `Codex` mengerjakan `build` dan `testing`
- `Claude` final decision
