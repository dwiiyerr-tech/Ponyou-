import { getOrchestrationTask, getOpenHandoffs } from "./agent-orchestrator.js";

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

function buildWorkerPrompt(task, context, worker) {
  const semantic = (context.semantic_matches || []).slice(0, 3).map((item) =>
    `- ${item.title} [${item.type}] score=${item.score}`
  );
  const experiment = context.experiment_summary
    ? JSON.stringify(context.experiment_summary, null, 2)
    : "null";

  const header = [
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Stage: ${task.current_stage}`,
    `Priority: ${task.priority}`,
    `Experiment ID: ${task.experiment_id ?? "none"}`,
    `Objective: ${task.objective}`,
  ].join("\n");

  if (worker === "gemini") {
    return [
      "You are working as Gemini, the research arm for Claude.",
      header,
      "",
      "Your assignment:",
      "- produce research notes and counter-arguments",
      "- identify unknowns and failure modes",
      "- do not make the final decision",
      "",
      "Candidate context:",
      JSON.stringify(task.candidate || {}, null, 2),
      "",
      "Relevant semantic memory:",
      semantic.length ? semantic.join("\n") : "- none",
      "",
      "Experiment summary:",
      experiment,
      "",
      "Return format:",
      "- findings",
      "- counter_arguments",
      "- confidence",
      "- unknowns",
      "- recommendation_for_claude",
    ].join("\n");
  }

  if (worker === "codex") {
    return [
      "You are working as Codex, the technical execution arm for Claude.",
      header,
      "",
      "Your assignment:",
      "- evaluate or implement the technical change for this task",
      "- keep the work bounded and verifiable",
      "- do not make the final product or risk decision",
      "",
      "Candidate context:",
      JSON.stringify(task.candidate || {}, null, 2),
      "",
      "Relevant semantic memory:",
      semantic.length ? semantic.join("\n") : "- none",
      "",
      "Experiment summary:",
      experiment,
      "",
      "Return format:",
      "- technical_plan_or_change",
      "- files_or_modules_affected",
      "- verification",
      "- risks",
      "- questions_for_claude",
    ].join("\n");
  }

  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const worker = args.to;

  if (worker !== "gemini" && worker !== "codex") {
    console.error("Usage: node infra/agent-collab/collab-dispatch.js --to gemini|codex");
    process.exit(1);
  }

  const handoffs = getOpenHandoffs({ owner: worker, limit: 1 });
  if (handoffs.length === 0) {
    console.error(`No open handoffs for ${worker}.`);
    process.exit(1);
  }

  const task = getOrchestrationTask({ id: handoffs[0].id });
  const prompt = buildWorkerPrompt(task.task, task.context, worker);
  if (!prompt) {
    console.error(`Could not build prompt for ${worker}.`);
    process.exit(1);
  }

  process.stdout.write(prompt);
}

main();
