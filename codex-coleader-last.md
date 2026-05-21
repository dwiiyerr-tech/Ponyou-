Handled one PR-009 task: import/export integration check.

This run changed:
- [tests/module-graph.test.js](/home/ubuntu/ponyou/tests/module-graph.test.js): added static ESM graph test for relative import resolution, named exports/re-exports, and local cycles without importing runtime entrypoints.
- [PR_QUEUE.md](/home/ubuntu/ponyou/PR_QUEUE.md): checked PR-009 import/export task.
- [PR_PROGRESS.md](/home/ubuntu/ponyou/PR_PROGRESS.md): added the permanent run note.

Verification:
- `node --check tests/module-graph.test.js`
- `npx vitest run tests/module-graph.test.js` -> 1 passed

No open Codex handoff/task id existed, so no `collab:submit` was needed. I stopped after this single PR-009 task.