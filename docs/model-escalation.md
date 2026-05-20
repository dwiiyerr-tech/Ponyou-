# Model Escalation

Dokumen ini menjelaskan kapan perlu tetap di `Haiku`, kapan pindah ke `Sonnet`, dan kapan naik ke `Opus` saat memakai `Claude Code` untuk workflow `Ponyou`.

Tujuan:
- menjaga token tetap hemat
- mencegah model besar dipakai untuk pekerjaan kecil
- membuat escalation model konsisten saat task berubah tingkat kesulitan

## Aturan Dasar

- `Haiku` untuk pekerjaan ringan, cepat, dan pendek.
- `Sonnet` untuk mayoritas kerja harian.
- `Opus` untuk keputusan final, review kritis, dan sintesis kompleks.
- Jika tersedia dan cocok, `opusplan` dipakai untuk sesi yang membutuhkan planning kuat lalu execution efisien.

## Mulai Dari Mana

Default yang aman:
- chat ringan, prompt singkat, handoff: `Haiku`
- kerja rutin, drafting, revisi normal: `Sonnet`
- planning berat, review, keputusan, debug sulit: `Opus`

## Kapan Tetap Di Haiku

Pakai `Haiku` bila:
- tugas hanya satu atau dua langkah
- output yang diinginkan pendek
- kamu sedang merapikan prompt
- kamu hanya butuh status, ringkasan, atau handoff
- konteks sudah jelas dan tidak banyak tradeoff

Contoh:
- menulis prompt worker singkat
- menulis summary task
- memanggil `collab:start` dan membaca output

## Kapan Naik Ke Sonnet

Pindah ke `Sonnet` bila:
- ada beberapa requirement sekaligus
- task mulai menyentuh banyak file atau stage
- kamu butuh reasoning yang lebih stabil daripada Haiku
- hasil sebelumnya masih terlalu dangkal
- perlu drafting yang tetap hemat tapi lebih tajam

Contoh:
- menyusun spec sederhana
- menulis checklist operasional
- mengedit prompt role
- membahas perubahan workflow kecil

## Kapan Wajib Opus

Naik ke `Opus` bila:
- keputusan final punya dampak mahal
- review menyangkut risk, release, atau correctness
- bug sulit direproduksi
- ada banyak tradeoff lintas modul
- kamu perlu sintesis besar dari beberapa sumber

Contoh:
- `decide`
- `review`
- postmortem besar
- debugging lintas modul
- desain ulang routing atau orchestration

## Opusplan

Gunakan `opusplan` jika:
- kamu ingin `Opus` untuk planning
- lalu otomatis pakai `Sonnet` saat execution
- task-nya cocok untuk workflow `plan -> build`

Ini cocok untuk:
- upgrade besar
- refactor bertahap
- sesi panjang yang berisi banyak planning tetapi eksekusinya tetap perlu efisien

## Practical Routing

Aturan praktis yang mudah diingat:

- `Haiku` = chat, draft, prompt, ringkasan
- `Sonnet` = kerja sehari-hari
- `Opus` = review dan keputusan sulit

Jika ragu:
1. mulai di `Haiku`
2. kalau jawabannya butuh sintesis lebih dari satu paragraf atau ada ambiguity, naik ke `Sonnet`
3. kalau dampaknya tinggi atau harus benar, naik ke `Opus`

## Why This Matters

Cara ini tidak otomatis, tetapi cukup dekat dengan perilaku yang bijak:
- biaya tetap terkontrol
- model besar tidak dipakai sia-sia
- sesi tetap cepat
- keputusan penting tetap mendapat kapasitas reasoning yang layak
