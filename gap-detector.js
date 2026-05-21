import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function detectGaps({
  prQueuePath = join(__dirname, "PR_QUEUE.md"),
  testsDir = join(__dirname, "tests"),
  stuckDaysThreshold = 1,
  nowMs = Date.now(),
} = {}) {
  const gaps = [];

  // ── Stuck PRs ───────────────────────────────────────────────────────────────
  let queueContent = "";
  try { queueContent = readFileSync(prQueuePath, "utf8"); } catch { return gaps; }

  const prBlocks = queueContent.split(/\n(?=## PR-)/).filter(b => /^## PR-/.test(b));
  for (const block of prBlocks) {
    const prMatch   = block.match(/^## (PR-\d+):/);
    const statusM   = block.match(/^Status:\s+(\S+)/m);
    const addedM    = block.match(/^Added:\s+(\d{4}-\d{2}-\d{2})/m);
    if (!prMatch || !statusM || !addedM) continue;

    const prId      = prMatch[1];
    const status    = statusM[1];
    const addedMs   = new Date(addedM[1]).getTime();
    const ageDays   = (nowMs - addedMs) / (1000 * 60 * 60 * 24);
    const unchecked = (block.match(/^- \[ \]/gm) || []).length;

    if ((status === "in_progress" || status === "pending") && ageDays > stuckDaysThreshold && unchecked > 0) {
      // Extract unchecked task lines
      const tasks = (block.match(/^- \[ \] .+/gm) || []).map(t => t.replace(/^- \[ \] /, "").trim());
      gaps.push({
        type: "stuck_pr",
        prId,
        status,
        ageDays: Number(ageDays.toFixed(1)),
        uncheckedTasks: unchecked,
        tasks,
        description: `${prId} stuck ${ageDays.toFixed(1)}d — ${unchecked} unchecked task(s)`,
      });
    }
  }

  // ── Modules without test coverage ───────────────────────────────────────────
  // Only check known feature modules introduced by PR-007+
  const PR_FEATURE_MODULES = [
    "gap-detector.js", "gap-agent.js", "task-decomposer.js",
    "kelly-mode-selector.js", "strategy-registry.js", "strategy-gate.js",
    "strategy-composer.js", "strategy-evolution-bus.js", "strategy-evolution-engine.js",
    "strategy-proposal.js", "vault-profit-sweep.js", "trading-plan-30.js",
  ];
  for (const mod of PR_FEATURE_MODULES) {
    const srcPath  = join(__dirname, mod);
    const testPath = join(testsDir, mod.replace(".js", ".test.js"));
    if (existsSync(srcPath) && !existsSync(testPath)) {
      gaps.push({
        type: "missing_test",
        file: mod,
        description: `${mod} has no test file at tests/${mod.replace(".js", ".test.js")}`,
      });
    }
  }

  // ── Tools without definitions ────────────────────────────────────────────────
  // Check if tools/ files have a matching tool definition
  const toolsDir = join(__dirname, "tools");
  let defsContent = "";
  try { defsContent = readFileSync(join(toolsDir, "definitions.js"), "utf8"); } catch { /* ok */ }

  if (defsContent && existsSync(toolsDir)) {
    const toolFiles = readdirSync(toolsDir).filter(f => f.endsWith(".js") && !f.startsWith("_"));
    for (const tf of toolFiles) {
      const name = tf.replace(".js", "");
      // Heuristic: if the file exports a function and no definition mentions it
      const src = (() => { try { return readFileSync(join(toolsDir, tf), "utf8"); } catch { return ""; } })();
      const hasExport = /^export\s+(async\s+)?function/.test(src);
      if (hasExport && !defsContent.includes(name) && !defsContent.includes(tf)) {
        gaps.push({
          type: "unwired_tool",
          file: `tools/${tf}`,
          description: `tools/${tf} has exports but no entry in tools/definitions.js`,
        });
      }
    }
  }

  return gaps;
}
