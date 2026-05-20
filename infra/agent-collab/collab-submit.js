import { autoSubmitWorkerResult } from "./workflow-bridge.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usage() {
  return [
    "Usage:",
    "node infra/agent-collab/collab-submit.js \\",
    '  --task-id 12 \\',
    '  --worker gemini|codex \\',
    '  [--agent gemini] \\',
    '  [--cli gemini] \\',
    '  [--findings \"item1,item2\"] \\',
    '  [--counter-arguments \"item1,item2\"] \\',
    '  [--unknowns \"item1,item2\"] \\',
    '  [--confidence 0.7] \\',
    '  [--recommendation \"Proceed to technical evaluation\"]',
    "",
    "Codex fields:",
    '  [--technical-plan-or-change \"item1,item2\"]',
    '  [--files-or-modules-affected \"file1,file2\"]',
    '  [--verification \"item1,item2\"]',
    '  [--risks \"item1,item2\"]',
    '  [--questions-for-claude \"item1,item2\"]',
    '  [--test-plan \"item1,item2\"]',
    '  [--test-results \"item1,item2\"]',
    '  [--failures \"item1,item2\"]',
    '  [--coverage-notes \"item1,item2\"]',
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    process.exit(0);
  }

  const required = ["task-id", "worker"];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`Missing required args: ${missing.join(", ")}`);
    console.error("");
    console.error(usage());
    process.exit(1);
  }

  const taskId = Number(args["task-id"]);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    console.error("Invalid --task-id. Use a positive integer.");
    process.exit(1);
  }

  const worker = String(args.worker).trim().toLowerCase();
  if (!["gemini", "codex"].includes(worker)) {
    console.error('Invalid worker. Use "gemini" or "codex".');
    process.exit(1);
  }

  const result = await autoSubmitWorkerResult({
    task_id: taskId,
    worker,
    agent: args.agent || worker,
    cli: args.cli || worker,
    findings: parseList(args.findings),
    counter_arguments: parseList(args["counter-arguments"]),
    unknowns: parseList(args.unknowns),
    confidence: parseNumber(args.confidence),
    recommendation_for_claude: args.recommendation || args["recommendation-for-claude"] || "",
    technical_plan_or_change: parseList(args["technical-plan-or-change"]),
    files_or_modules_affected: parseList(args["files-or-modules-affected"]),
    verification: parseList(args.verification),
    risks: parseList(args.risks),
    questions_for_claude: parseList(args["questions-for-claude"]),
    test_plan: parseList(args["test-plan"]),
    test_results: parseList(args["test-results"]),
    failures: parseList(args.failures),
    coverage_notes: parseList(args["coverage-notes"]),
  });

  if (result?.error) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    worker,
    task_id: taskId,
    result,
  }, null, 2));
}

await main();
