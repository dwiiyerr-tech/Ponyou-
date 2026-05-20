# Role Prompts

Template prompt di folder ini dipakai untuk menyetel perilaku 3 CLI dalam model:
- `Claude` = otak utama
- `Gemini` = tangan kanan riset
- `Codex` = tangan kiri eksekusi teknis

File:
- [claude-chief.md](/home/ubuntu/ponyou/infra/agent-collab/prompts/claude-chief.md)
- [gemini-researcher.md](/home/ubuntu/ponyou/infra/agent-collab/prompts/gemini-researcher.md)
- [codex-executor.md](/home/ubuntu/ponyou/infra/agent-collab/prompts/codex-executor.md)

Aturan pakai:
- pakai `Claude` prompt untuk session utama
- pakai `Gemini` prompt hanya saat riset, counter-argument, atau second opinion
- pakai `Codex` prompt hanya saat implementasi, refactor, test, atau review teknis
- semua hasil penting tetap masuk ke MCP collaboration layer
