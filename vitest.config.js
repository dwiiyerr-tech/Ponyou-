import { defineConfig } from "vitest/config";
import os from "os";
import path from "path";

// NOTE on DEP0040: vitest spawns worker processes for each test file and
// many transitive deps still import `punycode`. We can't pass --disable-warning
// to those workers via vitest config. Workers inherit NODE_OPTIONS, so we
// set it in the test scripts in package.json (`NODE_OPTIONS=--disable-warning=DEP0040`).

// Collab-layer stores (orchestrator/experiment/semantic + shared memory) use
// env-overridable paths. Point them at a throwaway tmp dir during tests so the
// suite NEVER touches the live bot's production state files (previously a
// `npm test` run wiped orchestrator-state.json / experiments.json / etc.).
// `test.env` is injected into every worker's process.env before test modules
// load, so each module's `process.env.X || default` resolves to these tmp
// paths. The dir is created/removed by tests/_globals.js (globalSetup).
const COLLAB_TMP = path.join(os.tmpdir(), "ponyou-vitest-collab");

export default defineConfig({
  test: {
    globalSetup: ["./tests/_globals.js"],
    env: {
      PONYOU_ORCH_FILE: path.join(COLLAB_TMP, "orchestrator-state.json"),
      PONYOU_EXPERIMENTS_FILE: path.join(COLLAB_TMP, "experiments.json"),
      PONYOU_EXPERIMENT_RUNS_FILE: path.join(COLLAB_TMP, "experiment-runs.jsonl"),
      PONYOU_SEMANTIC_MEMORY_FILE: path.join(COLLAB_TMP, "semantic-memory.jsonl"),
      COLLAB_SHARED_MEMORY_PATH: path.join(COLLAB_TMP, "shared-agent-memory.jsonl"),
    },
  },
});
