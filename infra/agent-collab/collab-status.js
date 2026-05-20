import { getExperimentOverview } from "./experiment-tracker.js";
import { listOrchestrationTasks } from "./agent-orchestrator.js";

function summarizeBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item?.[key] || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function main() {
  const tasks = listOrchestrationTasks({ limit: 50 });
  const experiments = getExperimentOverview({ limit: 20 });

  const payload = {
    tasks: {
      total: tasks.length,
      by_stage: summarizeBy(tasks, "current_stage"),
      by_status: summarizeBy(tasks, "status"),
      top: tasks.slice(0, 10).map((task) => ({
        id: task.id,
        title: task.title,
        stage: task.current_stage,
        status: task.status,
        priority: task.priority,
        updated_at: task.updated_at,
      })),
    },
    experiments: {
      total: experiments.length,
      by_recommendation: summarizeBy(experiments, "recommendation"),
      top: experiments.slice(0, 10),
    },
  };

  console.log(JSON.stringify(payload, null, 2));
}

main();
