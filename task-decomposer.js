// Keyword routing: maps task text to the right agent and decomposes into steps
const GEMINI_KEYWORDS  = /\b(research|analisis|analyz|riset|pattern|data|failure mode|edge case|investigate|study|compare|literature)\b/i;
const CLAUDE_KEYWORDS  = /\b(review|finalize|decide|evaluate|approve|gate|orchestrat|audit)\b/i;
// Codex handles everything else (build/implement/fix/write/test/create)

export const AGENTS = Object.freeze({ GEMINI: "gemini", CODEX: "codex", CLAUDE: "claude" });

export function routeTask(taskText) {
  if (GEMINI_KEYWORDS.test(taskText)) return AGENTS.GEMINI;
  if (CLAUDE_KEYWORDS.test(taskText))  return AGENTS.CLAUDE;
  return AGENTS.CODEX;
}

export function decomposeTask(taskText, { maxSubTasks = 5 } = {}) {
  const agent = routeTask(taskText);

  // Split on semicolons, "AND", "+", or comma-separated list patterns
  const raw = taskText
    .split(/[;+]|,\s+(?=\w)|(?:\s+and\s+)/i)
    .map(s => s.trim())
    .filter(Boolean);

  const subTasks = raw.length > 1
    ? raw.slice(0, maxSubTasks).map(t => ({ text: t, agent: routeTask(t) }))
    : [{ text: taskText, agent }];

  return {
    original: taskText,
    agent,
    subTasks,
    isAtomic: subTasks.length === 1,
  };
}

export function decomposeAll(tasks, opts = {}) {
  return tasks.map(t => decomposeTask(t, opts));
}
