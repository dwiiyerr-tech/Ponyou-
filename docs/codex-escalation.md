# Codex Escalation

Dokumen ini menjelaskan kapan perlu tetap pakai mode cepat di `Codex`, kapan naik ke model yang lebih kuat, dan kapan tetap di mode standar saat membangun `Ponyou`.

Tujuan:
- menjaga implementasi tetap cepat
- mencegah model berat dipakai untuk perubahan kecil
- menaikkan model hanya saat kompleksitas teknis membenarkannya

Catatan:
- Dokumen ini khusus untuk `Codex`.
- `Gemini` sengaja tidak diberi aturan eskalasi di sini.
- `MCP` tetap tidak memilih model; yang memilih tetap control plane `Codex`.

## Aturan Dasar

- mode cepat untuk perubahan kecil, prompt singkat, dan patch lokal
- mode standar untuk implementasi rutin dan refactor moderat
- mode kuat untuk debug sulit, refactor besar, atau testing lintas modul

## Kapan Tetap Di Mode Cepat

Pakai mode cepat bila:
- task hanya satu langkah
- perubahan kecil dan lokal
- kamu hanya butuh draft atau patch pendek
- bug sudah jelas sumbernya
- output yang dibutuhkan singkat

Contoh:
- edit prompt
- tambah satu fungsi kecil
- ubah satu test
- bikin wrapper command sederhana

## Kapan Naik Ke Mode Standar

Pindah ke mode standar bila:
- task menyentuh beberapa file
- butuh reasoning sedikit lebih panjang
- ada integrasi antar modul
- perlu test dan verifikasi yang konsisten
- kamu ingin tetap hemat tetapi lebih stabil dari mode cepat

Contoh:
- implementasi feature kecil sampai menengah
- refactor helper
- tambah workflow artifact baru
- rapikan command fallback

## Kapan Wajib Naik Ke Mode Kuat

Naik ke mode kuat bila:
- refactor besar
- bug sulit direproduksi
- perubahan menyentuh orchestration atau policy gate
- ada banyak tradeoff teknis
- correctness lebih penting daripada throughput

Contoh:
- ubah stage advancement logic
- ubah policy gate
- debug failure lintas CLI
- sinkronisasi data/memory yang kompleks

## Practical Routing

Aturan praktis:

- perubahan kecil: mode cepat
- perubahan rutin: mode standar
- perubahan mahal salahnya: mode kuat

Jika ragu:
1. mulai di mode cepat
2. kalau respons terlalu dangkal atau perubahan menyentuh banyak file, naik ke mode standar
3. kalau masih ambigu atau high-stakes, naik ke mode kuat

## Relation To Ponyou Workflow

Untuk workflow Ponyou:
- `Codex` tetap dipakai untuk `build` dan `testing`
- eskalasi model mengikuti ukuran perubahan dan risiko teknis
- hasil kerja tetap harus masuk ke `auto_submit_worker_result` atau `collab:submit`

## Why This Matters

Pendekatan ini membantu:
- menghemat token
- mengurangi overthinking pada perubahan kecil
- membuat review teknis lebih tajam saat problem memang berat
