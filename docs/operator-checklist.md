# Operator Checklist

Checklist singkat untuk menjalankan workflow `Ponyou` dari `Claude Code`, `Gemini`, dan `Codex`.

## Start

1. Buka repo `ponyou`.
2. Jalankan `npm run readiness`.
3. Jika targetnya live, jalankan juga `npm run readiness:live`.
4. Jika mode `live`, pastikan status `OK` dan baca semua warning sebelum start.
5. Jalankan `npm run demo` bila ingin sanity-check tanpa transaksi nyata.
6. Baru jalankan `npm run collab:start`.
7. Lihat `claude.next`, `gemini.next`, dan `codex.next`.
8. Jika belum ada task upgrade, jalankan `npm run collab:triage`.

## Jika Mau Membuat Upgrade Baru

1. Jalankan `npm run collab:upgrade -- ...`.
2. Pastikan output berisi `experiment_id`, `task_id`, `spec_id`, dan `plan_id`.
3. Delegasikan riset ke `Gemini` dengan `npm run collab:dispatch -- --to gemini`.
4. Delegasikan build/testing ke `Codex` dengan `npm run collab:dispatch -- --to codex`.

## Jika Worker Bisa Submit Langsung

- `Gemini` gunakan `auto_submit_worker_result` dengan `worker="gemini"`.
- `Codex` gunakan `auto_submit_worker_result` dengan `worker="codex"`.

## Jika Worker Tidak Bisa Submit Langsung

- Gunakan `npm run collab:submit -- ...` sebagai fallback.
- Jangan biarkan hasil worker hanya tinggal di chat.

## Model Guide

- `Claude`
  - `Sonnet` untuk kerja rutin
  - `Opus` untuk keputusan final dan review kritis
- `Gemini`
  - model research paling kuat yang tersedia untuk riset berat
- `Codex`
  - model coding efisien untuk build rutin
  - model lebih kuat untuk refactor besar atau debugging sulit

## Stage Guide

- `brainstorm`: `Claude`
- `research`: `Gemini`
- `spec`: `Claude`
- `plan`: `Claude`
- `build`: `Codex`
- `testing`: `Codex`
- `decide`: `Claude`
- `review`: `Claude`
- `learn`: `Claude`

## Closeout

1. Jalankan `validate_task_policy`.
2. Jika lolos, jalankan `finalize_task_with_policy`.
3. Simpan lesson penting ke semantic memory.
4. Kalau ada pola baru, tambahkan ke `collab:triage` untuk sesi berikutnya.
