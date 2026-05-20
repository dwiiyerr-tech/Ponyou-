const ROLE_SCHEMAS = {
  SCREENER: {
    verdict: { type: "enum", values: ["shadow", "probe", "active", "skip"] },
    confidence: { type: "number", min: 0, max: 100 },
    size_multiplier: { type: "number", min: 0, max: 1 },
    risk_flags: { type: "string_array" },
    reason: { type: "string" },
    next_action: { type: "string" },
  },
  MANAGER: {
    decision: { type: "enum", values: ["hold", "partial_exit", "exit", "skip"] },
    confidence: { type: "number", min: 0, max: 100 },
    risk_flags: { type: "string_array" },
    reason: { type: "string" },
    next_action: { type: "string" },
    exit_signal: { type: "nullable_string" },
  },
  LOSS_ANALYSIS: {
    root_cause: { type: "string_array" },
    missed_flags: { type: "string_array" },
    avoid_pattern: { type: "string_array" },
    lessons: { type: "string_array" },
    confidence: { type: "number", min: 0, max: 100 },
  },
  OBSERVATION_ANALYSIS: {
    insight: { type: "string" },
    adjustment: { type: "string_array" },
    lessons: { type: "string_array" },
    confidence: { type: "number", min: 0, max: 100 },
  },
  SUCCESS_ANALYSIS: {
    success_factor: { type: "string_array" },
    alpha_signal: { type: "string_array" },
    replicate_pattern: { type: "string_array" },
    lessons: { type: "string_array" },
    confidence: { type: "number", min: 0, max: 100 },
  },
  GENERAL: {
    summary: { type: "string" },
    confidence: { type: "number", min: 0, max: 100 },
    risk_flags: { type: "string_array" },
    next_action: { type: "string" },
    answer: { type: "string" },
  },
};

function schemaForRole(role = "GENERAL") {
  return ROLE_SCHEMAS[String(role || "GENERAL").toUpperCase()] || ROLE_SCHEMAS.GENERAL;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return null;
  const items = [];
  for (const entry of value) {
    const item = normalizeString(entry);
    if (item) items.push(item);
  }
  return items;
}

function validateField(value, spec) {
  if (spec.type === "string") {
    const normalized = normalizeString(value);
    return normalized ? { ok: true, value: normalized } : { ok: false, error: "must be a non-empty string" };
  }

  if (spec.type === "nullable_string") {
    if (value == null) return { ok: true, value: null };
    const normalized = normalizeString(value);
    return normalized ? { ok: true, value: normalized } : { ok: false, error: "must be a string or null" };
  }

  if (spec.type === "string_array") {
    const normalized = normalizeStringArray(value);
    return normalized ? { ok: true, value: normalized } : { ok: false, error: "must be an array of non-empty strings" };
  }

  if (spec.type === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false, error: "must be a finite number" };
    if (spec.min != null && num < spec.min) return { ok: false, error: `must be >= ${spec.min}` };
    if (spec.max != null && num > spec.max) return { ok: false, error: `must be <= ${spec.max}` };
    return { ok: true, value: num };
  }

  if (spec.type === "enum") {
    const normalized = normalizeString(value);
    if (!normalized) return { ok: false, error: "must be a non-empty string" };
    if (!spec.values.includes(normalized)) {
      return { ok: false, error: `must be one of: ${spec.values.join(", ")}` };
    }
    return { ok: true, value: normalized };
  }

  return { ok: false, error: "unsupported schema field" };
}

export function buildStructuredOutputBlock(role = "GENERAL") {
  const schema = schemaForRole(role);
  return `OUTPUT_SCHEMA: Return compact JSON only, with exactly these keys and types:
${JSON.stringify(schema, null, 2)}
RULES: No prose before or after JSON. Unknown keys are rejected. Arrays must contain strings. Keep confidence conservative when uncertain.`;
}

export function tryParseStructuredOutput(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function validateStructuredOutput(role = "GENERAL", parsed = null) {
  const schema = schemaForRole(role);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["output must be a JSON object"], normalized: null, role: String(role || "GENERAL").toUpperCase() };
  }

  const normalized = {};
  const errors = [];
  const allowedKeys = new Set(Object.keys(schema));
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unexpected key: ${key}`);
    }
  }

  for (const [key, spec] of Object.entries(schema)) {
    const result = validateField(parsed[key], spec);
    if (!result.ok) {
      errors.push(`${key}: ${result.error}`);
      continue;
    }
    normalized[key] = result.value;
  }

  if (errors.length > 0) {
    return { ok: false, errors, normalized: null, role: String(role || "GENERAL").toUpperCase() };
  }

  return { ok: true, errors: [], normalized, role: String(role || "GENERAL").toUpperCase() };
}

export function extractLessonsFromStructuredOutput(parsed, fallbackText = "") {
  const lessons = [];
  if (parsed && typeof parsed === "object") {
    const fields = [parsed.lessons, parsed.lesson, parsed.replicate_pattern, parsed.avoid_pattern, parsed.adjustment, parsed.root_cause, parsed.success_factor, parsed.alpha_signal];
    for (const field of fields) {
      if (Array.isArray(field)) {
        for (const item of field) if (typeof item === "string" && item.trim()) lessons.push(item.trim());
      } else if (typeof field === "string" && field.trim()) {
        lessons.push(field.trim());
      }
    }
  }
  const text = String(fallbackText || "");
  for (const match of text.matchAll(/(?:LESSON|ADJUSTMENT|REPLICATE_PATTERN|AVOID_PATTERN|ALPHA_SIGNAL)[:\-]\s*(.+)/gi)) {
    const value = match[1].trim();
    if (value) lessons.push(value);
  }
  return [...new Set(lessons)];
}
