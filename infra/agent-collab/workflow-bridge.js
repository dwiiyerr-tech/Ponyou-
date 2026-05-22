import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  addOrchestrationNote,
  advanceOrchestrationTask,
  getOrchestrationTask,
} from "./agent-orchestrator.js";
import { addSemanticMemory } from "./semantic-memory.js";
import { atomicWriteJson } from "../../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_FILE = path.join(__dirname, "workflow-artifacts.json");

function nowIso() {
  return new Date().toISOString();
}

function loadArtifacts() {
  if (!fs.existsSync(ARTIFACTS_FILE)) return { next_id: 1, artifacts: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(ARTIFACTS_FILE, "utf8"));
    return {
      next_id: Number.isFinite(parsed?.next_id) ? parsed.next_id : 1,
      artifacts: Array.isArray(parsed?.artifacts) ? parsed.artifacts : [],
    };
  } catch {
    return { next_id: 1, artifacts: [] };
  }
}

function saveArtifacts(data) {
  atomicWriteJson(ARTIFACTS_FILE, data);
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  if (value == null) return [];
  const text = String(value).trim();
  return text ? [text] : [];
}

function ensureTask(task_id) {
  const task = getOrchestrationTask({ id: task_id });
  if (task?.error) return task;
  return task;
}

function createArtifact({ task_id, kind, agent, cli, content, summary, status = "completed" }) {
  const store = loadArtifacts();
  const artifact = {
    id: store.next_id++,
    task_id: Number(task_id),
    kind,
    agent: agent || "unknown",
    cli: cli || "unknown",
    summary: String(summary || "").slice(0, 500),
    content: content && typeof content === "object" ? content : {},
    status,
    created_at: nowIso(),
  };
  store.artifacts.push(artifact);
  saveArtifacts(store);
  return artifact;
}

function listArtifactsForTask(task_id) {
  const store = loadArtifacts();
  return store.artifacts
    .filter((artifact) => artifact.task_id === Number(task_id))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

async function persistStage({
  task_id,
  kind,
  agent,
  cli,
  summary,
  content,
  orchestration_note,
  next_stage,
  semantic_type,
  semantic_tags = [],
}) {
  const task = ensureTask(task_id);
  if (task?.error) return task;

  const artifact = createArtifact({
    task_id,
    kind,
    agent,
    cli,
    content,
    summary,
  });

  addOrchestrationNote({
    id: task_id,
    note: orchestration_note || summary,
    agent,
    cli,
  });

  if (next_stage) {
    advanceOrchestrationTask({
      id: task_id,
      next_stage,
      note: orchestration_note || summary,
      agent,
      cli,
    });
  }

  if (semantic_type) {
    await addSemanticMemory({
      type: semantic_type,
      title: `${kind}:${task.task.title}`,
      summary,
      details: JSON.stringify(content, null, 2),
      tags: semantic_tags,
      project: task.task.project,
      branch: task.task.branch,
      source: "workflow-bridge",
    });
  }

  return {
    artifact,
    task: getOrchestrationTask({ id: task_id }),
  };
}

export async function workflowResearch({
  task_id,
  agent = "gemini",
  cli = "gemini",
  findings = [],
  counter_arguments = [],
  unknowns = [],
  confidence = null,
  recommendation_for_claude = "",
} = {}) {
  const summary = `research findings=${findings.length} counters=${counter_arguments.length} unknowns=${unknowns.length}`;
  return persistStage({
    task_id,
    kind: "research",
    agent,
    cli,
    summary,
    orchestration_note: recommendation_for_claude || summary,
    next_stage: "evaluate",
    semantic_type: "research-note",
    semantic_tags: ["research", "workflow"],
    content: {
      findings,
      counter_arguments,
      unknowns,
      confidence,
      recommendation_for_claude,
    },
  });
}

export async function workflowBrainstorm({
  task_id,
  agent = "claude",
  cli = "claude",
  idea = "",
  goals = [],
  non_goals = [],
  alternatives = [],
  open_questions = [],
} = {}) {
  const summary = `brainstorm goals=${goals.length} alternatives=${alternatives.length} questions=${open_questions.length}`;
  return persistStage({
    task_id,
    kind: "brainstorm",
    agent,
    cli,
    summary,
    orchestration_note: idea || summary,
    semantic_type: "brainstorm-note",
    semantic_tags: ["brainstorm", "workflow"],
    content: {
      idea,
      goals,
      non_goals,
      alternatives,
      open_questions,
    },
  });
}

export async function workflowSpec({
  task_id,
  agent = "claude",
  cli = "claude",
  problem_statement = "",
  success_criteria = [],
  constraints = [],
  acceptance_checks = [],
} = {}) {
  const summary = `spec criteria=${success_criteria.length} constraints=${constraints.length}`;
  return persistStage({
    task_id,
    kind: "spec",
    agent,
    cli,
    summary,
    orchestration_note: problem_statement || summary,
    semantic_type: "spec-note",
    semantic_tags: ["spec", "workflow"],
    content: {
      problem_statement,
      success_criteria,
      constraints,
      acceptance_checks,
    },
  });
}

export async function workflowPlan({
  task_id,
  agent = "claude",
  cli = "claude",
  milestones = [],
  risks = [],
  rollout_strategy = "",
  owner_map = {},
} = {}) {
  const summary = `plan milestones=${milestones.length} risks=${risks.length}`;
  return persistStage({
    task_id,
    kind: "plan",
    agent,
    cli,
    summary,
    orchestration_note: rollout_strategy || summary,
    semantic_type: "plan-note",
    semantic_tags: ["plan", "workflow"],
    content: {
      milestones,
      risks,
      rollout_strategy,
      owner_map,
    },
  });
}

export async function workflowBuild({
  task_id,
  agent = "codex",
  cli = "codex",
  changes = [],
  files = [],
  verification = [],
  residual_risks = [],
  next_stage = "decide",
} = {}) {
  const summary = `build changes=${changes.length} files=${files.length}`;
  return persistStage({
    task_id,
    kind: "build",
    agent,
    cli,
    summary,
    orchestration_note: verification[0] || summary,
    next_stage,
    semantic_type: "build-note",
    semantic_tags: ["build", "workflow"],
    content: {
      changes,
      files,
      verification,
      residual_risks,
    },
  });
}

export async function autoSubmitWorkerResult({
  task_id,
  worker,
  agent,
  cli,
  findings = [],
  counter_arguments = [],
  unknowns = [],
  confidence = null,
  recommendation_for_claude = "",
  changes = [],
  technical_plan_or_change = [],
  files = [],
  files_or_modules_affected = [],
  verification = [],
  risks = [],
  residual_risks = [],
  questions_for_claude = [],
  test_plan = [],
  test_results = [],
  failures = [],
  coverage_notes = [],
} = {}) {
  const task = ensureTask(task_id);
  if (task?.error) return task;

  const normalizedWorker = String(worker || "").trim().toLowerCase();
  const normalizedAgent = agent || normalizedWorker || "unknown";
  const normalizedCli = cli || normalizedWorker || "unknown";

  if (normalizedWorker === "gemini") {
    return workflowResearch({
      task_id,
      agent: normalizedAgent,
      cli: normalizedCli,
      findings: normalizeStringArray(findings),
      counter_arguments: normalizeStringArray(counter_arguments),
      unknowns: normalizeStringArray(unknowns),
      confidence,
      recommendation_for_claude: recommendation_for_claude || "Research submitted by Gemini.",
    });
  }

  if (normalizedWorker === "codex") {
    const originalStage = task.task.current_stage;
    const normalizedChanges = [
      ...normalizeStringArray(changes),
      ...normalizeStringArray(technical_plan_or_change),
    ];
    const normalizedFiles = [
      ...normalizeStringArray(files),
      ...normalizeStringArray(files_or_modules_affected),
    ];
    const normalizedVerification = normalizeStringArray(verification);
    const normalizedResidualRisks = [
      ...normalizeStringArray(risks),
      ...normalizeStringArray(residual_risks),
    ];
    const normalizedQuestions = normalizeStringArray(questions_for_claude);
    const normalizedTestPlan = normalizeStringArray(test_plan);
    const normalizedTestResults = normalizeStringArray(test_results);
    const normalizedFailures = normalizeStringArray(failures);
    const normalizedCoverageNotes = normalizeStringArray(coverage_notes);

    const artifacts = [];
    let latestTask = task;

    if (
      normalizedChanges.length
      || normalizedFiles.length
      || normalizedVerification.length
      || normalizedResidualRisks.length
    ) {
      const buildResult = await workflowBuild({
        task_id,
        agent: normalizedAgent,
        cli: normalizedCli,
        changes: normalizedChanges,
        files: normalizedFiles,
        verification: normalizedVerification,
        residual_risks: normalizedResidualRisks,
        next_stage: null,
      });
      if (buildResult?.error) return buildResult;
      artifacts.push(buildResult.artifact);
      latestTask = buildResult.task;
    }

    if (
      normalizedTestPlan.length
      || normalizedTestResults.length
      || normalizedFailures.length
      || normalizedCoverageNotes.length
    ) {
      const testingResult = await workflowTesting({
        task_id,
        agent: normalizedAgent,
        cli: normalizedCli,
        test_plan: normalizedTestPlan,
        test_results: normalizedTestResults,
        failures: normalizedFailures,
        coverage_notes: normalizedCoverageNotes,
      });
      if (testingResult?.error) return testingResult;
      artifacts.push(testingResult.artifact);
      latestTask = testingResult.task;
    }

    if (normalizedQuestions.length) {
      addOrchestrationNote({
        id: task_id,
        note: `Questions for Claude: ${normalizedQuestions.join(" | ")}`,
        agent: normalizedAgent,
        cli: normalizedCli,
      });
      latestTask = getOrchestrationTask({ id: task_id });
    }

    if (!artifacts.length && !normalizedQuestions.length) {
      return { error: "No recognized Codex result fields provided." };
    }

    if (artifacts.length > 0) {
      const nextStage = originalStage === "execute" ? "review" : "decide";
      const advancedTask = advanceOrchestrationTask({
        id: task_id,
        next_stage: nextStage,
        note: normalizedQuestions.length
          ? `Questions for Claude: ${normalizedQuestions.join(" | ")}`
          : `Codex submitted ${artifacts.length} artifact(s).`,
        agent: normalizedAgent,
        cli: normalizedCli,
      });
      if (!advancedTask?.error) {
        latestTask = advancedTask;
      }
    }

    return { artifacts, task: latestTask };
  }

  return { error: `Unsupported worker: ${worker}` };
}

export async function workflowTesting({
  task_id,
  agent = "codex",
  cli = "codex",
  test_plan = [],
  test_results = [],
  failures = [],
  coverage_notes = [],
} = {}) {
  const summary = `testing results=${test_results.length} failures=${failures.length}`;
  return persistStage({
    task_id,
    kind: "testing",
    agent,
    cli,
    summary,
    orchestration_note: failures.length ? failures[0] : summary,
    semantic_type: "testing-note",
    semantic_tags: ["testing", "workflow"],
    content: {
      test_plan,
      test_results,
      failures,
      coverage_notes,
    },
  });
}

export function getWorkflowArtifacts({ task_id, kind } = {}) {
  const artifacts = listArtifactsForTask(task_id);
  return kind ? artifacts.filter((artifact) => artifact.kind === kind) : artifacts;
}

export function _resetWorkflowArtifactsForTests() {
  if (fs.existsSync(ARTIFACTS_FILE)) fs.unlinkSync(ARTIFACTS_FILE);
}
