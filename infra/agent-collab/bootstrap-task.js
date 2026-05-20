import { createExperiment } from "./experiment-tracker.js";
import { createOrchestrationTask } from "./agent-orchestrator.js";

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

function usage() {
  return [
    "Usage:",
    "node infra/agent-collab/bootstrap-task.js \\",
    '  --title "Tighter rug gate for probes" \\',
    '  --objective "Evaluate whether lower rug threshold improves probe quality" \\',
    '  --hypothesis "Lower rug threshold reduces false positives in HOT regimes" \\',
    '  --baseline-rule "rug_score<35" \\',
    '  --candidate-rule "rug_score<28" \\',
    '  [--owner gemini] [--project ponyou] [--tags risk,probe] \\',
    '  [--symbol ABC] [--market-condition HOT] [--narrative AI] [--tier MICRO_CAP] \\',
    '  [--branch feat/probe-gate] [--priority high] [--notes "Initial experiment seed"]',
  ].join("\n");
}

function buildCandidate(args) {
  const candidate = {};
  if (args.symbol) candidate.symbol = args.symbol;
  if (args.mint) candidate.mint = args.mint;
  if (args["market-condition"]) candidate.market_condition = args["market-condition"];
  if (args.narrative) candidate.narrative = args.narrative;
  if (args.tier) candidate.tier = args.tier;
  return candidate;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(usage());
    process.exit(0);
  }

  const required = ["title", "objective", "hypothesis", "baseline-rule", "candidate-rule"];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`Missing required args: ${missing.join(", ")}`);
    console.error("");
    console.error(usage());
    process.exit(1);
  }

  const experiment = createExperiment({
    name: args.title,
    hypothesis: args.hypothesis,
    baseline_rule: args["baseline-rule"],
    candidate_rule: args["candidate-rule"],
    owner: args.owner || "claude",
    status: args.status || "draft",
    minimum_sample_size: args["minimum-sample-size"] || 30,
    tags: parseList(args.tags),
    notes: args.notes || "",
  });

  if (experiment?.error) {
    console.error(JSON.stringify(experiment, null, 2));
    process.exit(1);
  }

  const orchestration = createOrchestrationTask({
    title: args.title,
    objective: args.objective,
    candidate: buildCandidate(args),
    project: args.project || "ponyou",
    branch: args.branch || null,
    tags: parseList(args.tags),
    experiment_id: experiment.id,
    priority: args.priority || "normal",
  });

  if (orchestration?.error) {
    console.error(JSON.stringify(orchestration, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    experiment_id: experiment.id,
    task_id: orchestration.task.id,
    experiment,
    task: {
      id: orchestration.task.id,
      title: orchestration.task.title,
      current_stage: orchestration.task.current_stage,
      priority: orchestration.task.priority,
    },
  }, null, 2));
}

await main();
