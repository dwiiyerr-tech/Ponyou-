const REQUIRED_RULE_FIELDS = ["signal"];
const BUY_SELL_ACTIONS = new Set(["BUY", "SELL"]);
const TAKE_PROFIT_FIELDS = new Set(["tpPct", "takeProfitPct", "takeProfitBps"]);
const TIGHTER_IS_LOWER_FIELDS = new Set([
  "stopPct",
  "stopLossPct",
  "stopLossBps",
  "maxDrawdownPct",
  "maxSlippageBps",
  "maxPositionPct",
]);
const CANDIDATE_META_FIELDS = new Set([
  "id",
  "name",
  "type",
  "source",
  "reason",
  "regime",
  "rules",
  "scores",
  "evidence",
  "conviction",
  "createdAt",
  "updatedAt",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function uniqueValues(values) {
  return [...new Set(values.filter(value => value !== undefined && value !== null))];
}

function mergeSignals(a, b) {
  const left = Array.isArray(a) ? a : [a];
  const right = Array.isArray(b) ? b : [b];
  const merged = uniqueValues([...left, ...right]);
  return merged.length === 1 ? merged[0] : merged;
}

function mergeObjectsConservatively(a, b) {
  const merged = {};
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    merged[key] = mergeRuleValue(key, a[key], b[key]);
  }
  return merged;
}

function mergeRuleValue(key, a, b) {
  if (a === undefined) return clone(b);
  if (b === undefined) return clone(a);
  if (key === "signal") return mergeSignals(a, b);
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [a];
    const right = Array.isArray(b) ? b : [b];
    return uniqueValues([...left, ...right]).map(clone);
  }
  if (isPlainObject(a) && isPlainObject(b)) return mergeObjectsConservatively(a, b);
  if (typeof a === "boolean" && typeof b === "boolean") return a || b;
  if (typeof a === "number" && typeof b === "number") {
    if (TAKE_PROFIT_FIELDS.has(key) || TIGHTER_IS_LOWER_FIELDS.has(key) || key.startsWith("max")) {
      return Math.min(a, b);
    }
    return Math.max(a, b);
  }
  return clone(a);
}

function candidateLabel(strategy) {
  return String(strategy?.id ?? strategy?.name ?? "unknown");
}

function inferRegime(stratA, stratB, fallback = null) {
  if (fallback !== undefined && fallback !== null) return fallback;
  if (stratA?.regime && stratA.regime === stratB?.regime) return stratA.regime;
  return stratA?.regime ?? stratB?.regime ?? null;
}

function parseLlmPayload(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractRules(raw) {
  if (!isPlainObject(raw)) return null;
  if (isPlainObject(raw.rules)) return clone(raw.rules);

  const rules = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!CANDIDATE_META_FIELDS.has(key)) rules[key] = clone(value);
  }
  return rules;
}

function hasBuySellAction(raw, rules) {
  for (const source of [raw, rules]) {
    if (!isPlainObject(source)) continue;
    for (const key of ["action", "side", "tradeAction", "recommendation"]) {
      const value = source[key];
      if (typeof value === "string" && BUY_SELL_ACTIONS.has(value.trim().toUpperCase())) {
        return true;
      }
    }
  }
  return false;
}

function isValidRuleSchema(raw, rules) {
  if (!isPlainObject(raw) || !isPlainObject(rules) || Object.keys(rules).length === 0) return false;
  if (hasBuySellAction(raw, rules)) return false;

  for (const field of REQUIRED_RULE_FIELDS) {
    if (!(field in rules)) return false;
    if (typeof rules[field] === "string" && rules[field].trim() === "") return false;
  }

  if (typeof rules.signal === "string" && BUY_SELL_ACTIONS.has(rules.signal.trim().toUpperCase())) {
    return false;
  }
  if (rules.entryRsi != null) {
    const rsi = Number(rules.entryRsi);
    if (!Number.isFinite(rsi) || rsi < 0 || rsi > 100) return false;
  }
  for (const key of [...TAKE_PROFIT_FIELDS, ...TIGHTER_IS_LOWER_FIELDS]) {
    if (rules[key] == null) continue;
    const value = Number(rules[key]);
    if (!Number.isFinite(value) || value <= 0) return false;
  }

  return true;
}

export class StrategyComposer {
  #registry;
  #llmGenerator;

  constructor({ registry, llmGenerator = null }) {
    this.#registry = registry;
    this.#llmGenerator = llmGenerator;
  }

  selectBest(regime) {
    return this.#registry.getBestActive(regime) ?? null;
  }

  compose(stratA, stratB, { regime = undefined, reason = null } = {}) {
    if (!isPlainObject(stratA?.rules) || !isPlainObject(stratB?.rules)) {
      throw new Error("StrategyComposer.compose requires two strategies with rules");
    }

    const left = candidateLabel(stratA);
    const right = candidateLabel(stratB);
    const merged = mergeObjectsConservatively(stratA.rules, stratB.rules);
    return {
      type: "compose",
      name: `${left}+${right}-hybrid`,
      rules: merged,
      regime: inferRegime(stratA, stratB, regime),
      source: `composed from ${left} + ${right}`,
      parents: [left, right],
      reason,
    };
  }

  async generate(context) {
    if (!this.#llmGenerator) return null;
    try {
      const raw = parseLlmPayload(await this.#llmGenerator(context));
      const rules = extractRules(raw);
      if (!isValidRuleSchema(raw, rules)) return null;
      return {
        type: "generate",
        name: raw.name ?? "llm-generated",
        rules,
        regime: raw.regime ?? context?.regime ?? null,
        source: raw.source ?? "llm",
        reason: raw.reason ?? null,
      };
    } catch {
      return null;
    }
  }
}

export function validateStrategyRuleSchema(raw) {
  const payload = parseLlmPayload(raw);
  return isValidRuleSchema(payload, extractRules(payload));
}
