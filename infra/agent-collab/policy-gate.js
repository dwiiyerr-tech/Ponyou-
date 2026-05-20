import { getExperimentSummary } from "./experiment-tracker.js";
import { addOrchestrationNote, getOrchestrationTask } from "./agent-orchestrator.js";
import { getWorkflowArtifacts } from "./workflow-bridge.js";

function hasArtifact(artifacts, kind) {
  return artifacts.some((artifact) => artifact.kind === kind);
}

export function validateTaskPolicy({ task_id, pending_agent = null } = {}) {
  const task = getOrchestrationTask({ id: task_id });
  if (task?.error) return task;

  const artifacts = getWorkflowArtifacts({ task_id });
  const experiment = task.task.experiment_id
    ? getExperimentSummary({ id: task.task.experiment_id })
    : null;

  const issues = [];
  const warnings = [];

  if (!hasArtifact(artifacts, "spec")) issues.push("Missing spec artifact.");
  if (!hasArtifact(artifacts, "plan")) issues.push("Missing plan artifact.");
  if (!hasArtifact(artifacts, "testing")) issues.push("Missing testing artifact.");
  if (!hasArtifact(artifacts, "build")) warnings.push("No build artifact found.");

  const decisionNotes = (task.task.stages || [])
    .filter((stage) => stage.stage === "decide" || stage.stage === "review" || stage.stage === "learn")
    .flatMap((stage) => stage.notes || [])
    .filter((note) => note.agent === "claude");
  if (decisionNotes.length === 0 && pending_agent !== "claude") {
    issues.push("No Claude decision/review note recorded.");
  }

  if (experiment && !experiment.error) {
    const summary = experiment.summary || {};
    const minimum = experiment.experiment?.minimum_sample_size || 0;
    if ((summary.sample_size || 0) < minimum) {
      warnings.push("Experiment sample size is below the configured minimum.");
    }
    if (summary.recommendation === "review_manually") {
      warnings.push("Experiment still requires manual review.");
    }
  }

  return {
    task_id: task.task.id,
    title: task.task.title,
    current_stage: task.task.current_stage,
    passes: issues.length === 0,
    issues,
    warnings,
    artifact_counts: artifacts.reduce((acc, artifact) => {
      acc[artifact.kind] = (acc[artifact.kind] || 0) + 1;
      return acc;
    }, {}),
    experiment_summary: experiment?.summary || null,
  };
}

export function finalizeTaskWithPolicy({ task_id, agent = "claude", cli = "claude", note = "" } = {}) {
  const validation = validateTaskPolicy({ task_id, pending_agent: agent });
  if (validation?.error) return validation;
  if (agent !== "claude") {
    return {
      error: "Only Claude may finalize a task.",
      validation,
    };
  }
  if (!validation.passes) {
    return {
      error: "Policy gate failed.",
      validation,
    };
  }

  addOrchestrationNote({
    id: task_id,
    stage: "learn",
    note: note || "Task finalized by Claude after passing policy gate.",
    agent,
    cli,
    status: "completed",
  });

  const task = getOrchestrationTask({ id: task_id });
  task.task.status = "completed";
  return {
    ok: true,
    validation,
    task,
  };
}
