import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getExperimentSummary } from "./experiment-tracker.js";
import { getRecentSemanticMemory, searchSemanticMemory } from "./semantic-memory.js";
import { atomicWriteJson } from "../../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_FILE = process.env.PONYOU_ORCH_FILE || path.join(__dirname, "orchestrator-state.json");
const SHARED_MEMORY_FILE = process.env.COLLAB_SHARED_MEMORY_PATH || path.join(__dirname, "../../shared-agent-memory.jsonl");
const STAGES = ["research", "evaluate", "decide", "execute", "review", "learn"];
const DEFAULT_OWNERS = { research: "gemini", evaluate: "codex", decide: "claude", execute: "codex", review: "claude", learn: "claude" };

function nowIso() { return new Date().toISOString(); }
function safeArray(value) { return Array.isArray(value) ? value.filter(Boolean).map(String) : []; }
function stageOwner(stage, owners = {}) { return owners[stage] || DEFAULT_OWNERS[stage] || "claude"; }

function loadState() {
  if (!fs.existsSync(ORCH_FILE)) return { next_id: 1, tasks: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(ORCH_FILE, "utf8"));
    return { next_id: Number.isFinite(parsed?.next_id) ? parsed.next_id : 1, tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [] };
  } catch { return { next_id: 1, tasks: [] }; }
}

function saveState(data) { atomicWriteJson(ORCH_FILE, data); }
function appendSharedMemory(entry) { fs.appendFileSync(SHARED_MEMORY_FILE, `${JSON.stringify(entry)}\n`, "utf8"); }
function findTask(state, id) { return state.tasks.find((task) => task.id === Number(id)); }

function normalizeTask({ title, objective, candidate = {}, project = "ponyou", branch = null, tags = [], experiment_id = null, priority = "normal" } = {}) {
  if (!title || !objective) return { error: "title and objective are required" };
  return {
    title: String(title).slice(0, 200),
    objective: String(objective).slice(0, 800),
    candidate: candidate && typeof candidate === "object" ? candidate : {},
    project: project ? String(project) : "ponyou",
    branch: branch ? String(branch) : null,
    tags: safeArray(tags),
    experiment_id: experiment_id == null ? null : Number(experiment_id),
    priority: String(priority || "normal"),
  };
}

function buildMemoryContext(task) {
  const candidate = task.candidate || {};
  return {
    semantic_matches: searchSemanticMemory({
      query: [candidate.symbol, candidate.narrative, candidate.market_condition, ...safeArray(task.tags)].filter(Boolean).join(" "),
      project: task.project,
      market_condition: candidate.market_condition,
      narrative: candidate.narrative,
      tier: candidate.tier,
      limit: 5,
    }),
    recent_memory: getRecentSemanticMemory({ project: task.project, limit: 5 }),
    experiment_summary: task.experiment_id ? (getExperimentSummary({ id: task.experiment_id })?.summary || null) : null,
  };
}

function logStageEvent(task, event) {
  appendSharedMemory({
    id: `${nowIso()}-${Math.random().toString(36).slice(2, 10)}`,
    ts: nowIso(),
    agent: event.agent || stageOwner(task.current_stage, task.owners),
    cli: event.cli || "orchestrator",
    type: event.type || "progress",
    topic: `${task.title}#${task.current_stage}`,
    project: task.project,
    branch: task.branch,
    task: task.id,
    tags: [...safeArray(task.tags), task.current_stage],
    summary: event.summary || `${task.title} -> ${task.current_stage}`,
    details: event.details || "",
    status: event.status || task.status,
    related_ids: [],
  });
}

export function createOrchestrationTask(args = {}) {
  const normalized = normalizeTask(args);
  if (normalized.error) return normalized;
  const state = loadState();
  const id = state.next_id++;
  const task = {
    id,
    ...normalized,
    status: "open",
    current_stage: "research",
    stages: STAGES.map((stage) => ({
      stage, owner: stageOwner(stage), status: stage === "research" ? "active" : "pending",
      notes: [], started_at: stage === "research" ? nowIso() : null, completed_at: null,
    })),
    owners: { ...DEFAULT_OWNERS },
    history: [{ ts: nowIso(), action: "created", stage: "research", note: normalized.objective }],
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  state.tasks.push(task);
  saveState(state);
  logStageEvent(task, { type: "handoff", summary: `Task ${task.id} created for research`, details: task.objective, status: "open" });
  return { task, context: buildMemoryContext(task) };
}

export function advanceOrchestrationTask({ id, next_stage, note = "", agent, cli, status } = {}) {
  const state = loadState();
  const task = findTask(state, id);
  if (!task) return { error: `Task ${id} not found` };
  if (!STAGES.includes(next_stage)) return { error: `Invalid stage: ${next_stage}` };
  const current = task.stages.find((stage) => stage.stage === task.current_stage);
  if (current) {
    current.status = "completed";
    current.completed_at = nowIso();
    if (note) current.notes.push({ ts: nowIso(), note: String(note), agent: agent || null });
  }
  const target = task.stages.find((stage) => stage.stage === next_stage);
  target.status = "active";
  target.started_at = target.started_at || nowIso();
  if (note) target.notes.push({ ts: nowIso(), note: String(note), agent: agent || null });
  task.current_stage = next_stage;
  task.status = status || (next_stage === "learn" ? "review_pending" : "open");
  task.updated_at = nowIso();
  task.history.push({ ts: nowIso(), action: "advance", from: current?.stage || null, to: next_stage, note: String(note || ""), agent: agent || null });
  saveState(state);
  logStageEvent(task, { agent, cli, type: next_stage === "review" || next_stage === "learn" ? "handoff" : "progress", summary: `Task ${task.id} advanced to ${next_stage}`, details: note, status: task.status });
  return { task, context: buildMemoryContext(task) };
}

export function addOrchestrationNote({ id, stage, note, agent, cli, status } = {}) {
  const state = loadState();
  const task = findTask(state, id);
  if (!task) return { error: `Task ${id} not found` };
  const targetStage = stage || task.current_stage;
  const slot = task.stages.find((item) => item.stage === targetStage);
  if (!slot) return { error: `Stage ${targetStage} not found` };
  slot.notes.push({ ts: nowIso(), note: String(note || ""), agent: agent || null });
  if (status) {
    slot.status = status;
    task.status = status;
  }
  task.updated_at = nowIso();
  task.history.push({ ts: nowIso(), action: "note", stage: targetStage, note: String(note || ""), agent: agent || null });
  saveState(state);
  logStageEvent(task, { agent, cli, type: "progress", summary: `Task ${task.id} note on ${targetStage}`, details: note, status: task.status });
  return task;
}

export function getOrchestrationTask({ id } = {}) {
  const state = loadState();
  const task = findTask(state, id);
  if (!task) return { error: `Task ${id} not found` };
  return { task, context: buildMemoryContext(task) };
}

export function listOrchestrationTasks({ status, stage, limit = 10 } = {}) {
  const state = loadState();
  return state.tasks
    .filter((task) => (!status || task.status === status) && (!stage || task.current_stage === stage))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, Math.max(1, Number(limit || 10)));
}

export function getOpenHandoffs({ owner, limit = 10 } = {}) {
  return listOrchestrationTasks({ status: "open", limit: Math.max(limit * 2, 10) })
    .filter((task) => !owner || stageOwner(task.current_stage, task.owners) === owner)
    .slice(0, Math.max(1, Number(limit || 10)))
    .map((task) => ({
      id: task.id,
      title: task.title,
      current_stage: task.current_stage,
      owner: stageOwner(task.current_stage, task.owners),
      priority: task.priority,
      updated_at: task.updated_at,
      tags: task.tags,
    }));
}

export function _resetOrchestrationForTests() { if (fs.existsSync(ORCH_FILE)) fs.unlinkSync(ORCH_FILE); }
