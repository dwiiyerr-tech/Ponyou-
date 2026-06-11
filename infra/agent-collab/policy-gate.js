import { getExperimentSummary } from "./experiment-tracker.js";
import { addOrchestrationNote, getOrchestrationTask } from "./agent-orchestrator.js";
import { getWorkflowArtifacts } from "./workflow-bridge.js";

function hasArtifact(artifacts, kind) {
  return artifacts.some((artifact) => artifact.kind === kind);
}

/**
 * Deep check: artifact exists AND has substantive content.
 * Guards against skeleton/placeholder artifacts that pass existence checks
 * but carry no actual work product (empty content object, blank summary).
 * Returns { ok, reason } so callers get a specific failure message.
 */
function depthCheckArtifact(artifacts, kind) {
  const found = artifacts.find((a) => a.kind === kind);
  if (!found) return { ok: false, reason: `Missing ${kind} artifact.` };

  // Check summary is non-trivial (> 5 chars, not just "{}" or "done")
  const summary = String(found.summary || "").trim();
  if (summary.length < 6) {
    return { ok: false, reason: `${kind} artifact has empty/trivial summary ("${summary}")` };
  }

  // Check content object has at least one key with a non-empty value
  const content = found.content;
  if (!content || typeof content !== "object") {
    return { ok: false, reason: `${kind} artifact content is not an object` };
  }
  const contentKeys = Object.keys(content).filter(
    (k) => content[k] !== null && content[k] !== undefined && content[k] !== ""
  );
  if (contentKeys.length === 0) {
    return { ok: false, reason: `${kind} artifact content is empty ({})` };
  }

  return { ok: true, reason: null };
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

  // Depth-check required artifacts — existence alone is not enough.
  // An empty spec or empty test artifact passes the old hasArtifact() check
  // but indicates the worker submitted a placeholder, not real work.
  const specCheck    = depthCheckArtifact(artifacts, "spec");
  const planCheck    = depthCheckArtifact(artifacts, "plan");
  const testingCheck = depthCheckArtifact(artifacts, "testing");

  if (!specCheck.ok)    issues.push(specCheck.reason);
  if (!planCheck.ok)    issues.push(planCheck.reason);
  if (!testingCheck.ok) issues.push(testingCheck.reason);
  if (!hasArtifact(artifacts, "build")) warnings.push("No build artifact found.");

  // Stages must be executed (or explicitly waived) in order. An audit on
  // 2026-06-11 found 18 owner stages still "pending" on tasks whose later
  // stages had progressed — gemini/codex stages silently skipped while the
  // gate passed. A pending stage behind the frontier blocks finalize unless
  // it carries a note (a recorded, conscious waiver downgrades to a warning).
  const stagesArr = task.task.stages || [];
  let frontier = -1;
  stagesArr.forEach((stage, idx) => {
    if (stage.status === "completed" || stage.status === "active") frontier = idx;
  });
  for (let idx = 0; idx < frontier; idx++) {
    const stage = stagesArr[idx];
    if (stage.status !== "pending") continue;
    const owner = stage.owner || "unassigned";
    if ((stage.notes || []).length > 0) {
      warnings.push(`Stage ${stage.stage} (owner ${owner}) skipped with a waiver note.`);
    } else {
      issues.push(`Stage ${stage.stage} (owner ${owner}) was skipped silently — execute it or record a waiver note on that stage.`);
    }
  }

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

  // PG-2: re-fetch after the note write — addOrchestrationNote already
  // persisted status="completed" to disk, so this read reflects the final
  // state. Previously we also re-assigned task.task.status here, which
  // was a no-op since the persisted record was already correct.
  const task = getOrchestrationTask({ id: task_id });
  return {
    ok: true,
    validation,
    task,
  };
}
