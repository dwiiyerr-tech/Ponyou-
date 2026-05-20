import { getExperimentOverview, getExperimentSummary } from "./experiment-tracker.js";
import { getRecentSemanticMemory } from "./semantic-memory.js";
import { listOrchestrationTasks } from "./agent-orchestrator.js";

function buildIdeas() {
  const ideas = [];

  const experiments = getExperimentOverview({ limit: 50 });
  for (const experiment of experiments) {
    if (experiment.recommendation === "review_manually") {
      ideas.push({
        type: "experiment_review",
        priority_score: 88,
        title: `Review ambiguous experiment: ${experiment.name}`,
        why: "Experiment reached sufficient sample but still needs manual judgment.",
        source: { experiment_id: experiment.id },
        suggested_next_step: "Claude reviews the experiment summary and decides revise/promote/reject.",
      });
    }
    if (experiment.recommendation === "insufficient_data") {
      ideas.push({
        type: "experiment_extend",
        priority_score: 68,
        title: `Extend experiment sample: ${experiment.name}`,
        why: "Experiment is active but has not reached a reliable sample size.",
        source: { experiment_id: experiment.id },
        suggested_next_step: "Gemini checks if the hypothesis is still relevant; Codex continues bounded evaluation if yes.",
      });
    }
    if (experiment.comparison?.quality_lift <= -5) {
      ideas.push({
        type: "experiment_regression",
        priority_score: 93,
        title: `Investigate regression: ${experiment.name}`,
        why: "Candidate change appears worse than baseline by quality score.",
        source: { experiment_id: experiment.id },
        suggested_next_step: "Claude decides whether to revert, refine, or kill the candidate rule.",
      });
    }
  }

  const recentMemory = getRecentSemanticMemory({ limit: 100, project: "ponyou" });
  const memoryBuckets = new Map();
  for (const entry of recentMemory) {
    const key = `${entry.type}:${(entry.tags || []).slice(0, 2).join("|") || "general"}`;
    memoryBuckets.set(key, (memoryBuckets.get(key) || 0) + 1);
  }
  for (const [bucket, count] of memoryBuckets.entries()) {
    if (count >= 3) {
      ideas.push({
        type: "memory_pattern",
        priority_score: 72 + Math.min(15, count),
        title: `Repeated memory pattern detected: ${bucket}`,
        why: `There are ${count} recent decision-grade notes in the same bucket, suggesting a recurring issue or theme.`,
        source: { bucket, count },
        suggested_next_step: "Claude reviews the recurring pattern and decides if it should become an experiment or a new guardrail.",
      });
    }
  }

  const tasks = listOrchestrationTasks({ limit: 100 });
  const stuckTasks = tasks.filter((task) => {
    const ageMs = Date.now() - new Date(task.updated_at).getTime();
    return ageMs > 24 * 60 * 60 * 1000 && task.status === "open";
  });
  for (const task of stuckTasks) {
    ideas.push({
      type: "stalled_task",
      priority_score: 75,
      title: `Stalled task: ${task.title}`,
      why: `Task is still open and has not progressed for more than 24 hours.`,
      source: { task_id: task.id, stage: task.current_stage },
      suggested_next_step: "Claude decides whether to close, revise, or re-dispatch the task.",
    });
  }

  return ideas
    .sort((a, b) => b.priority_score - a.priority_score || a.title.localeCompare(b.title))
    .slice(0, 20);
}

function buildDeepContext(ideas) {
  return ideas.slice(0, 5).map((idea) => {
    if (idea.source?.experiment_id) {
      const summary = getExperimentSummary({ id: idea.source.experiment_id });
      return {
        idea_title: idea.title,
        experiment: summary?.experiment || null,
        summary: summary?.summary || null,
      };
    }
    return {
      idea_title: idea.title,
      source: idea.source,
    };
  });
}

function main() {
  const ideas = buildIdeas();
  const payload = {
    generated_at: new Date().toISOString(),
    count: ideas.length,
    ideas,
    top_context: buildDeepContext(ideas),
  };
  console.log(JSON.stringify(payload, null, 2));
}

main();
