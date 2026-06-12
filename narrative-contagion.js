const CONTAGION_WINDOW_MS = 2 * 60 * 60 * 1000;
const _ruggedNarratives = new Map();

function normalizeNarrative(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function pushNarrative(out, value) {
  const normalized = normalizeNarrative(value);
  if (normalized && !out.includes(normalized)) out.push(normalized);
}

export function extractNarratives(token = {}) {
  const narratives = [];
  pushNarrative(narratives, token.narrative);
  pushNarrative(narratives, token.conviction?.narrative_cluster?.narrative);
  pushNarrative(narratives, token.signal_snapshot?.conviction?.narrative_cluster?.narrative);
  pushNarrative(narratives, token.signal_snapshot?.narrative);

  const tagSources = [
    token.narrative_tags,
    token.signal_snapshot?.narrative_tags,
  ];
  for (const tags of tagSources) {
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag === "string") pushNarrative(narratives, tag);
      else {
        pushNarrative(narratives, tag?.narrative);
        pushNarrative(narratives, tag?.tag);
        pushNarrative(narratives, tag?.name);
        pushNarrative(narratives, tag?.value);
      }
    }
  }

  return narratives;
}

export function isRugExitReason(reason = "") {
  return /rug|honeypot|scam|liquidity[_ -]?removal|dev[_ -]?sell|lp[_ -]?drain/i.test(String(reason || ""));
}

function pruneStale(nowMs) {
  for (const [narrative, entry] of _ruggedNarratives.entries()) {
    if (!entry?.lastTs || nowMs - entry.lastTs > CONTAGION_WINDOW_MS) {
      _ruggedNarratives.delete(narrative);
    }
  }
}

export function recordRuggedNarrativesForExit({ reason, token = {}, nowMs = Date.now() } = {}) {
  if (!isRugExitReason(reason)) return [];
  const narratives = extractNarratives(token);
  if (narratives.length === 0) return [];

  pruneStale(nowMs);
  const recorded = [];
  for (const narrative of narratives) {
    const prev = _ruggedNarratives.get(narrative);
    const count = prev && nowMs - prev.lastTs <= CONTAGION_WINDOW_MS
      ? (prev.count || 0) + 1
      : 1;
    const entry = { count, lastTs: nowMs };
    _ruggedNarratives.set(narrative, entry);
    recorded.push({ narrative, ...entry });
  }
  return recorded;
}

function getContagionForToken(token, nowMs) {
  for (const narrative of extractNarratives(token)) {
    const entry = _ruggedNarratives.get(narrative);
    if (!entry || nowMs - entry.lastTs > CONTAGION_WINDOW_MS) continue;
    if ((entry.count || 0) >= 2) return { narrative, count: entry.count };
  }
  return null;
}

export function filterNarrativeContagion(candidates = [], { nowMs = Date.now(), logFn = () => {} } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  pruneStale(nowMs);

  return candidates.filter(candidate => {
    const contagion = getContagionForToken(candidate, nowMs);
    if (!contagion) return true;

    logFn(
      "narrative_contagion",
      `skipping ${candidate.symbol || candidate.mint || "UNKNOWN"} — narrative "${contagion.narrative}" had ${contagion.count} rugs`
    );
    return false;
  });
}

/**
 * Snapshot of narratives with recent rugs (inside the contagion window).
 * Consumed by the vault proposal engine to suggest narrative blacklisting.
 */
export function getRuggedNarratives({ nowMs = Date.now() } = {}) {
  pruneStale(nowMs);
  return [..._ruggedNarratives.entries()]
    .map(([narrative, entry]) => ({
      narrative,
      rug_count: entry.count || 0,
      last_rug_at: new Date(entry.lastTs).toISOString(),
    }))
    .sort((a, b) => b.rug_count - a.rug_count);
}

export function clearRuggedNarratives() {
  _ruggedNarratives.clear();
}
