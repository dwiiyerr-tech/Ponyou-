import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import {
  createExperiment,
  getExperimentOverview,
  getExperimentSummary,
  listExperiments,
  recordExperimentRun,
  updateExperimentStatus,
} from "./infra/agent-collab/experiment-tracker.js";
import {
  addSemanticMemory,
  getRecentSemanticMemory,
  indexExperimentMemory,
  searchSemanticMemory,
} from "./infra/agent-collab/semantic-memory.js";
import {
  addOrchestrationNote,
  advanceOrchestrationTask,
  createOrchestrationTask,
  getOpenHandoffs,
  getOrchestrationTask,
  listOrchestrationTasks,
} from "./infra/agent-collab/agent-orchestrator.js";
import {
  autoSubmitWorkerResult,
  workflowBrainstorm,
  getWorkflowArtifacts,
  workflowBuild,
  workflowPlan,
  workflowResearch,
  workflowSpec,
  workflowTesting,
} from "./infra/agent-collab/workflow-bridge.js";
import {
  finalizeTaskWithPolicy,
  validateTaskPolicy,
} from "./infra/agent-collab/policy-gate.js";

const STORE_PATH = process.env.COLLAB_STORE_PATH
  || path.join(process.cwd(), "shared-agent-memory.jsonl");

const server = new Server(
  { name: "collaboration-memory", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

function ensureStore() {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, "", "utf8");
  }
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function readEntries() {
  ensureStore();
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendEntry(entry) {
  ensureStore();
  fs.appendFileSync(STORE_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

function formatEntry(entry) {
  return JSON.stringify(entry, null, 2);
}

function normalizeEntry(args = {}) {
  const now = new Date().toISOString();
  const type = args.type || "note";
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    ts: now,
    agent: args.agent || "unknown",
    cli: args.cli || "unknown",
    type,
    topic: args.topic || null,
    project: args.project || null,
    branch: args.branch || null,
    task: args.task || null,
    tags: safeArray(args.tags),
    summary: args.summary || "",
    details: args.details || "",
    status: args.status || null,
    related_ids: safeArray(args.related_ids),
  };
}

function matchesQuery(entry, query) {
  if (!query) return true;
  const haystack = JSON.stringify(entry).toLowerCase();
  return haystack.includes(String(query).toLowerCase());
}

function sortDesc(entries) {
  return [...entries].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
}

function filterEntries(entries, args = {}) {
  return entries.filter((entry) => {
    if (args.type && entry.type !== args.type) return false;
    if (args.agent && entry.agent !== args.agent) return false;
    if (args.cli && entry.cli !== args.cli) return false;
    if (args.project && entry.project !== args.project) return false;
    if (args.branch && entry.branch !== args.branch) return false;
    if (args.topic && entry.topic !== args.topic) return false;
    if (args.status && entry.status !== args.status) return false;
    if (args.tag && !safeArray(entry.tags).includes(args.tag)) return false;
    if (!matchesQuery(entry, args.query)) return false;
    return true;
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "collab_log_entry",
      description:
        "Simpan ide, evaluasi, keputusan, handoff, atau progres lintas CLI ke shared memory.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Nama agent atau operator, mis. codex, gemini, claude" },
          cli: { type: "string", description: "Nama CLI asal entry" },
          type: {
            type: "string",
            enum: ["idea", "plan", "progress", "evaluation", "decision", "handoff", "risk", "note"],
            description: "Jenis catatan kolaborasi",
          },
          topic: { type: "string" },
          project: { type: "string" },
          branch: { type: "string" },
          task: { type: "string" },
          summary: { type: "string", description: "Ringkasan singkat" },
          details: { type: "string", description: "Rincian lengkap" },
          status: { type: "string", description: "Status opsional seperti open, blocked, done" },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          related_ids: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["agent", "cli", "type", "summary"],
        additionalProperties: false,
      },
    },
    {
      name: "collab_recent_entries",
      description: "Ambil entry terbaru dari shared memory, bisa difilter menurut tipe atau agent.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Jumlah entry, default 10" },
          type: { type: "string" },
          agent: { type: "string" },
          cli: { type: "string" },
          project: { type: "string" },
          branch: { type: "string" },
          topic: { type: "string" },
          status: { type: "string" },
          tag: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "collab_search_entries",
      description: "Cari ide, evaluasi, keputusan, atau handoff berdasarkan query teks.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Kata kunci bebas" },
          limit: { type: "number", description: "Jumlah hasil, default 10" },
          type: { type: "string" },
          project: { type: "string" },
          branch: { type: "string" },
          tag: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "collab_get_handoffs",
      description: "Ambil handoff terbuka agar CLI lain bisa melanjutkan pekerjaan atau evaluasi.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          branch: { type: "string" },
          agent: { type: "string" },
          limit: { type: "number", description: "Jumlah hasil, default 10" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "create_experiment",
      description: "Buat eksperimen trading formal untuk kolaborasi lintas CLI.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          hypothesis: { type: "string" },
          baseline_rule: { type: "string" },
          candidate_rule: { type: "string" },
          owner: { type: "string" },
          status: { type: "string" },
          minimum_sample_size: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["name", "hypothesis", "baseline_rule", "candidate_rule"],
        additionalProperties: false,
      },
    },
    {
      name: "update_experiment_status",
      description: "Ubah status eksperimen kolaboratif.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          status: { type: "string" },
          notes: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "record_experiment_run",
      description: "Catat run baseline atau candidate untuk eksperimen.",
      inputSchema: {
        type: "object",
        properties: {
          experiment_id: { type: "number" },
          variant: { type: "string", enum: ["baseline", "candidate"] },
          sample_size: { type: "number" },
          wins: { type: "number" },
          losses: { type: "number" },
          pnl_pct: { type: "number" },
          max_drawdown_pct: { type: "number" },
          avg_hold_minutes: { type: "number" },
          avg_slippage: { type: "number" },
          false_positive_rate: { type: "number" },
          rugs_avoided: { type: "number" },
          tail_capture_pct: { type: "number" },
          notes: { type: "string" },
        },
        required: ["experiment_id", "variant"],
        additionalProperties: false,
      },
    },
    {
      name: "list_experiments",
      description: "List eksperimen kolaboratif.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          tag: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_experiment_summary",
      description: "Ambil ringkasan eksperimen tertentu.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "get_experiment_overview",
      description: "Ambil overview eksperimen terbaru.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "add_semantic_memory",
      description: "Simpan catatan decision-grade ke semantic memory kolaborasi.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          details: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          project: { type: "string" },
          branch: { type: "string" },
          market_condition: { type: "string" },
          narrative: { type: "string" },
          tier: { type: "string" },
          mint: { type: "string" },
          wallet: { type: "string" },
          deployer: { type: "string" },
          source: { type: "string" },
        },
        required: ["type", "title", "summary"],
        additionalProperties: false,
      },
    },
    {
      name: "search_semantic_memory",
      description: "Cari postmortem, eksperimen, dan risk note yang mirip.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          type: { type: "string" },
          tag: { type: "string" },
          project: { type: "string" },
          branch: { type: "string" },
          market_condition: { type: "string" },
          narrative: { type: "string" },
          tier: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_recent_semantic_memory",
      description: "Ambil semantic memory terbaru.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          type: { type: "string" },
          tag: { type: "string" },
          project: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "index_experiment_memory",
      description: "Index hasil eksperimen ke semantic memory.",
      inputSchema: {
        type: "object",
        properties: {
          experiment_id: { type: "number" },
        },
        required: ["experiment_id"],
        additionalProperties: false,
      },
    },
    {
      name: "create_orchestration_task",
      description: "Buat task orchestration lintas CLI.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          objective: { type: "string" },
          candidate: { type: "object" },
          project: { type: "string" },
          branch: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          experiment_id: { type: "number" },
          priority: { type: "string" },
        },
        required: ["title", "objective"],
        additionalProperties: false,
      },
    },
    {
      name: "advance_orchestration_task",
      description: "Pindahkan orchestration task ke stage berikutnya.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          next_stage: { type: "string", enum: ["research", "evaluate", "decide", "execute", "review", "learn"] },
          note: { type: "string" },
          agent: { type: "string" },
          cli: { type: "string" },
          status: { type: "string" },
        },
        required: ["id", "next_stage"],
        additionalProperties: false,
      },
    },
    {
      name: "add_orchestration_note",
      description: "Tambahkan note ke orchestration task.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          stage: { type: "string" },
          note: { type: "string" },
          agent: { type: "string" },
          cli: { type: "string" },
          status: { type: "string" },
        },
        required: ["id", "note"],
        additionalProperties: false,
      },
    },
    {
      name: "get_orchestration_task",
      description: "Ambil task orchestration dan context stage aktif.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "list_orchestration_tasks",
      description: "List orchestration task.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          stage: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_open_handoffs",
      description: "Ambil handoff orchestration terbuka untuk owner tertentu.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "workflow_brainstorm",
      description: "Tahap brainstorming awal untuk ide, goal, alternatif, dan open questions sebelum research/spec lebih detail.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          agent: { type: "string" },
          cli: { type: "string" },
          idea: { type: "string" },
          goals: { type: "array", items: { type: "string" } },
          non_goals: { type: "array", items: { type: "string" } },
          alternatives: { type: "array", items: { type: "string" } },
          open_questions: { type: "array", items: { type: "string" } },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_research",
      description: "Tahap research bersama: biasanya diisi Gemini untuk temuan, kontra-argumen, dan unknowns.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          agent: { type: "string" },
          cli: { type: "string" },
          findings: { type: "array", items: { type: "string" } },
          counter_arguments: { type: "array", items: { type: "string" } },
          unknowns: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          recommendation_for_claude: { type: "string" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_spec",
      description: "Tahap spec: biasanya diisi Claude untuk problem statement, criteria, dan acceptance checks.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          agent: { type: "string" },
          cli: { type: "string" },
          problem_statement: { type: "string" },
          success_criteria: { type: "array", items: { type: "string" } },
          constraints: { type: "array", items: { type: "string" } },
          acceptance_checks: { type: "array", items: { type: "string" } },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_plan",
      description: "Tahap planning: milestones, risks, rollout strategy, dan owner map.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          agent: { type: "string" },
          cli: { type: "string" },
          milestones: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          rollout_strategy: { type: "string" },
          owner_map: { type: "object" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_build",
      description: "Tahap build: biasanya diisi Codex untuk perubahan teknis dan verifikasi implementasi.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          agent: { type: "string" },
          cli: { type: "string" },
          changes: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
          verification: { type: "array", items: { type: "string" } },
          residual_risks: { type: "array", items: { type: "string" } },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "workflow_testing",
      description: "Tahap testing: test plan, hasil, failure, dan coverage notes.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          agent: { type: "string" },
          cli: { type: "string" },
          test_plan: { type: "array", items: { type: "string" } },
          test_results: { type: "array", items: { type: "string" } },
          failures: { type: "array", items: { type: "string" } },
          coverage_notes: { type: "array", items: { type: "string" } },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "auto_submit_worker_result",
      description: "Jalur auto-submit untuk Gemini atau Codex agar hasil kerja langsung masuk ke workflow artifact dan orchestration task yang benar.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          worker: { type: "string", enum: ["gemini", "codex"] },
          agent: { type: "string" },
          cli: { type: "string" },
          findings: { type: "array", items: { type: "string" } },
          counter_arguments: { type: "array", items: { type: "string" } },
          unknowns: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          recommendation_for_claude: { type: "string" },
          changes: { type: "array", items: { type: "string" } },
          technical_plan_or_change: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } },
          files_or_modules_affected: { type: "array", items: { type: "string" } },
          verification: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          residual_risks: { type: "array", items: { type: "string" } },
          questions_for_claude: { type: "array", items: { type: "string" } },
          test_plan: { type: "array", items: { type: "string" } },
          test_results: { type: "array", items: { type: "string" } },
          failures: { type: "array", items: { type: "string" } },
          coverage_notes: { type: "array", items: { type: "string" } },
        },
        required: ["task_id", "worker"],
        additionalProperties: false,
      },
    },
    {
      name: "get_workflow_artifacts",
      description: "Ambil artifact workflow research/spec/plan/testing/build untuk satu task.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          kind: { type: "string" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "validate_task_policy",
      description: "Cek apakah task memenuhi gate minimum sebelum dianggap selesai atau dipromosikan.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    {
      name: "finalize_task_with_policy",
      description: "Finalize task hanya jika policy gate lolos dan dipanggil oleh Claude.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number" },
          agent: { type: "string" },
          cli: { type: "string" },
          note: { type: "string" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "collab_log_entry") {
    const entry = normalizeEntry(args);
    appendEntry(entry);
    return textResult(formatEntry(entry));
  }

  if (name === "collab_recent_entries") {
    const limit = Number(args.limit || 10);
    const entries = sortDesc(filterEntries(readEntries(), args)).slice(0, limit);
    return textResult(JSON.stringify(entries, null, 2));
  }

  if (name === "collab_search_entries") {
    const limit = Number(args.limit || 10);
    const entries = sortDesc(filterEntries(readEntries(), args)).slice(0, limit);
    return textResult(JSON.stringify(entries, null, 2));
  }

  if (name === "collab_get_handoffs") {
    const limit = Number(args.limit || 10);
    const entries = sortDesc(
      filterEntries(readEntries(), {
        ...args,
        type: "handoff",
        status: args.status || "open",
      })
    ).slice(0, limit);
    return textResult(JSON.stringify(entries, null, 2));
  }

  if (name === "create_experiment") return textResult(JSON.stringify(createExperiment(args), null, 2));
  if (name === "update_experiment_status") return textResult(JSON.stringify(updateExperimentStatus(args), null, 2));
  if (name === "record_experiment_run") return textResult(JSON.stringify(recordExperimentRun(args), null, 2));
  if (name === "list_experiments") return textResult(JSON.stringify(listExperiments(args), null, 2));
  if (name === "get_experiment_summary") return textResult(JSON.stringify(getExperimentSummary(args), null, 2));
  if (name === "get_experiment_overview") return textResult(JSON.stringify(getExperimentOverview({ limit: args.limit || 10 }), null, 2));
  if (name === "add_semantic_memory") return textResult(JSON.stringify(await addSemanticMemory(args), null, 2));
  if (name === "search_semantic_memory") return textResult(JSON.stringify(searchSemanticMemory(args), null, 2));
  if (name === "get_recent_semantic_memory") return textResult(JSON.stringify(getRecentSemanticMemory(args), null, 2));
  if (name === "index_experiment_memory") return textResult(JSON.stringify(await indexExperimentMemory(args), null, 2));
  if (name === "create_orchestration_task") return textResult(JSON.stringify(createOrchestrationTask(args), null, 2));
  if (name === "advance_orchestration_task") return textResult(JSON.stringify(advanceOrchestrationTask(args), null, 2));
  if (name === "add_orchestration_note") return textResult(JSON.stringify(addOrchestrationNote(args), null, 2));
  if (name === "get_orchestration_task") return textResult(JSON.stringify(getOrchestrationTask(args), null, 2));
  if (name === "list_orchestration_tasks") return textResult(JSON.stringify(listOrchestrationTasks(args), null, 2));
  if (name === "get_open_handoffs") return textResult(JSON.stringify(getOpenHandoffs(args), null, 2));
  if (name === "workflow_brainstorm") return textResult(JSON.stringify(await workflowBrainstorm(args), null, 2));
  if (name === "workflow_research") return textResult(JSON.stringify(await workflowResearch(args), null, 2));
  if (name === "workflow_spec") return textResult(JSON.stringify(await workflowSpec(args), null, 2));
  if (name === "workflow_plan") return textResult(JSON.stringify(await workflowPlan(args), null, 2));
  if (name === "workflow_build") return textResult(JSON.stringify(await workflowBuild(args), null, 2));
  if (name === "workflow_testing") return textResult(JSON.stringify(await workflowTesting(args), null, 2));
  if (name === "auto_submit_worker_result") return textResult(JSON.stringify(await autoSubmitWorkerResult(args), null, 2));
  if (name === "get_workflow_artifacts") return textResult(JSON.stringify(getWorkflowArtifacts(args), null, 2));
  if (name === "validate_task_policy") return textResult(JSON.stringify(validateTaskPolicy(args), null, 2));
  if (name === "finalize_task_with_policy") return textResult(JSON.stringify(finalizeTaskWithPolicy(args), null, 2));

  return errorResult(`Unknown tool: ${name}`);
});

ensureStore();
const transport = new StdioServerTransport();
await server.connect(transport);
