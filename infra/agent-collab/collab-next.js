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

function buildSuggestedAction(task) {
  switch (task.current_stage) {
    case "research":
      return "Ask Gemini to produce research notes and counter-arguments, then advance to evaluate.";
    case "evaluate":
      return "Ask Codex to assess or implement the technical change, then advance to decide.";
    case "decide":
      return "Claude reviews experiment + semantic context and makes the final decision.";
    case "execute":
      return "Ask Codex to execute the approved implementation or rollout step.";
    case "review":
      return "Claude performs final review and determines whether the task can close or return for revision.";
    case "learn":
      return "Claude captures reusable lessons and indexes important outcomes into semantic memory.";
    default:
      return "Inspect task context and choose the next bounded action.";
  }
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
      "Preferred submit path:",
      "- call MCP tool `auto_submit_worker_result`",
      '- set `task_id` to this task id and `worker` to `"gemini"`',
      "- include: findings, counter_arguments, confidence, unknowns, recommendation_for_claude",
      "",
      "Fallback return format if tool submit is unavailable:",
      "{",
      '  "findings": ["..."],',
      '  "counter_arguments": ["..."],',
      '  "confidence": 0.0,',
      '  "unknowns": ["..."],',
      '  "recommendation_for_claude": "..."',
      "}",
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
      "Preferred submit path:",
      "- call MCP tool `auto_submit_worker_result`",
      '- set `task_id` to this task id and `worker` to `"codex"`',
      "- include: technical_plan_or_change, files_or_modules_affected, verification, risks, questions_for_claude",
      "- include test_plan, test_results, failures, coverage_notes when tests were run",
      "",
      "Fallback return format if tool submit is unavailable:",
      "{",
      '  "technical_plan_or_change": ["..."],',
      '  "files_or_modules_affected": ["..."],',
      '  "verification": ["..."],',
      '  "risks": ["..."],',
      '  "questions_for_claude": ["..."],',
      '  "test_plan": ["..."],',
      '  "test_results": ["..."],',
      '  "failures": ["..."],',
      '  "coverage_notes": ["..."]',
      "}",
    ].join("\n");
  }

  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const owner = args.owner || "claude";
  const worker = args.for || null;
  const handoffs = getOpenHandoffs({ owner, limit: 1 });

  if (handoffs.length === 0) {
    console.log(JSON.stringify({
      owner,
      next: null,
      message: "No open handoffs for this owner.",
    }, null, 2));
    return;
  }

  const task = getOrchestrationTask({ id: handoffs[0].id });
  const payload = {
    owner,
    next: {
      id: task.task.id,
      title: task.task.title,
      stage: task.task.current_stage,
      priority: task.task.priority,
      experiment_id: task.task.experiment_id,
      suggested_action: buildSuggestedAction(task.task),
      semantic_matches: task.context.semantic_matches.slice(0, 3).map((item) => ({
        title: item.title,
        type: item.type,
        score: item.score,
      })),
      experiment_summary: task.context.experiment_summary,
    },
  };

  if (worker === "gemini" || worker === "codex") {
    payload.worker = worker;
    payload.prompt = buildWorkerPrompt(task.task, task.context, worker);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main();
