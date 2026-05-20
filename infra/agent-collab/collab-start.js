import { getExperimentOverview } from "./experiment-tracker.js";
import { getOrchestrationTask, getOpenHandoffs, listOrchestrationTasks } from "./agent-orchestrator.js";

function summarizeBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item?.[key] || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function buildSuggestedAction(task) {
  switch (task.current_stage) {
    case "research":
      return "Delegate research to Gemini.";
    case "evaluate":
      return "Delegate technical evaluation or implementation to Codex.";
    case "decide":
      return "Make the final decision as Claude.";
    case "execute":
      return "Delegate approved execution to Codex.";
    case "review":
      return "Run final review as Claude.";
    case "learn":
      return "Capture lessons and index memory as Claude.";
    default:
      return "Inspect task context.";
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

function nextForOwner(owner) {
  const handoffs = getOpenHandoffs({ owner, limit: 1 });
  if (handoffs.length === 0) return null;
  const task = getOrchestrationTask({ id: handoffs[0].id });
  return {
    id: task.task.id,
    title: task.task.title,
    stage: task.task.current_stage,
    priority: task.task.priority,
    experiment_id: task.task.experiment_id,
    suggested_action: buildSuggestedAction(task.task),
    prompt: owner === "claude" ? null : buildWorkerPrompt(task.task, task.context, owner),
  };
}

function main() {
  const tasks = listOrchestrationTasks({ limit: 50 });
  const experiments = getExperimentOverview({ limit: 20 });

  const payload = {
    status: {
      tasks_total: tasks.length,
      tasks_by_stage: summarizeBy(tasks, "current_stage"),
      tasks_by_status: summarizeBy(tasks, "status"),
      experiments_total: experiments.length,
      experiments_by_recommendation: summarizeBy(experiments, "recommendation"),
    },
    claude: {
      next: nextForOwner("claude"),
    },
    gemini: {
      next: nextForOwner("gemini"),
    },
    codex: {
      next: nextForOwner("codex"),
    },
  };

  console.log(JSON.stringify(payload, null, 2));
}

main();
