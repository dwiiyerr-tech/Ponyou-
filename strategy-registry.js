import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteJson } from "./atomic-write.js";

export const STRATEGY_STATUSES = Object.freeze({
  CANDIDATE: "candidate",
  BACKTESTING: "backtesting",
  PAPER: "paper",
  LIVE_TRIAL: "live_trial",
  ACTIVE: "active",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
});

const VALID_STATUSES = new Set(Object.values(STRATEGY_STATUSES));

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object" || !record.id) return null;
  const status = VALID_STATUSES.has(record.status) ? record.status : STRATEGY_STATUSES.CANDIDATE;
  return {
    id: String(record.id),
    name: record.name ?? "unnamed-strategy",
    type: record.type ?? "unknown",
    status,
    source: record.source ?? "manual",
    rules: clone(record.rules ?? {}),
    regime: record.regime ?? null,
    scores: clone(record.scores ?? {}),
    evidence: clone(record.evidence ?? null),
    rejectReason: record.rejectReason ?? null,
    deactivationReason: record.deactivationReason ?? null,
    activatedAt: record.activatedAt ?? null,
    deactivatedAt: record.deactivatedAt ?? null,
    rejectedAt: record.rejectedAt ?? null,
    createdAt: record.createdAt ?? nowIso(),
    updatedAt: record.updatedAt ?? null,
  };
}

function scoreFor(record, regime = null) {
  const regimeScores = regime ? record.scores?.regimes?.[regime] : null;
  for (const source of [regimeScores, record.scores]) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["live", "winRate", "score", "paper", "backtest"]) {
      const value = Number(source[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return 0;
}

export class StrategyRegistry {
  #catalog = new Map();
  #persistPath;

  constructor({ persistPath = "./strategy-registry.json" } = {}) {
    this.#persistPath = persistPath;
    if (this.#persistPath) this.#load();
  }

  register({ id = randomUUID(), name, type, rules = {}, regime = null, source = "manual", scores = {} } = {}) {
    if (!id) throw new Error("StrategyRegistry: id is required");
    if (this.#catalog.has(id)) throw new Error(`StrategyRegistry: duplicate id ${id}`);

    const record = normalizeRecord({
      id,
      name,
      type,
      status: STRATEGY_STATUSES.CANDIDATE,
      source,
      rules,
      regime,
      scores,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    this.#catalog.set(record.id, record);
    this.#persist();
    return record.id;
  }

  get(id) {
    return clone(this.#catalog.get(id) ?? null);
  }

  getAll() {
    return [...this.#catalog.values()].map(record => clone(record));
  }

  activate(id, scores = {}) {
    const record = this.#mustGet(id);
    const { evidence, ...scoreSnapshot } = scores && typeof scores === "object" ? scores : {};
    record.status = STRATEGY_STATUSES.ACTIVE;
    record.scores = clone(scoreSnapshot);
    if (evidence !== undefined) record.evidence = clone(evidence);
    record.rejectReason = null;
    record.deactivationReason = null;
    record.activatedAt = nowIso();
    record.deactivatedAt = null;
    record.updatedAt = nowIso();
    this.#persist();
    return clone(record);
  }

  reject(id, reason, evidence = null) {
    const record = this.#mustGet(id);
    record.status = STRATEGY_STATUSES.REJECTED;
    record.rejectReason = reason || "rejected";
    if (evidence !== null) record.evidence = clone(evidence);
    record.rejectedAt = nowIso();
    record.updatedAt = nowIso();
    this.#persist();
    return clone(record);
  }

  deactivate(id, reason = "deactivated") {
    const record = this.#mustGet(id);
    record.status = STRATEGY_STATUSES.SUPERSEDED;
    record.deactivationReason = reason;
    record.deactivatedAt = nowIso();
    record.updatedAt = nowIso();
    this.#persist();
    return clone(record);
  }

  getBestActive(regime = null) {
    const active = [...this.#catalog.values()]
      .filter(record => record.status === STRATEGY_STATUSES.ACTIVE)
      .filter(record => !regime || !record.regime || record.regime === regime);

    active.sort((left, right) => {
      const scoreDelta = scoreFor(right, regime) - scoreFor(left, regime);
      if (scoreDelta !== 0) return scoreDelta;
      return String(right.activatedAt || right.createdAt).localeCompare(String(left.activatedAt || left.createdAt));
    });

    return clone(active[0] ?? null);
  }

  #mustGet(id) {
    const record = this.#catalog.get(id);
    if (!record) throw new Error(`StrategyRegistry: unknown id ${id}`);
    return record;
  }

  #load() {
    if (!fs.existsSync(this.#persistPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#persistPath, "utf8"));
      const records = Array.isArray(parsed) ? parsed : parsed?.strategies;
      if (!Array.isArray(records)) return;
      for (const record of records) {
        const normalized = normalizeRecord(record);
        if (normalized) this.#catalog.set(normalized.id, normalized);
      }
    } catch {
      this.#catalog.clear();
    }
  }

  #persist() {
    if (!this.#persistPath) return;
    fs.mkdirSync(path.dirname(this.#persistPath), { recursive: true });
    atomicWriteJson(this.#persistPath, [...this.#catalog.values()]);
  }
}
