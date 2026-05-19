export function normalizeBooleanFlag(value) {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

export function resolveExecutionMode({
  env = process.env,
  userConfig = {},
} = {}) {
  const rawMode =
    userConfig.executionMode ??
    env.EXECUTION_MODE ??
    null;

  const rawDemo =
    userConfig.demoMode ??
    env.DEMO_MODE ??
    null;

  const rawDryRun =
    userConfig.dryRun ??
    env.DRY_RUN ??
    null;

  const normalizedMode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : null;
  const demoFlag = normalizeBooleanFlag(rawDemo);
  const dryRunFlag = normalizeBooleanFlag(rawDryRun);

  let mode = "live";
  if (normalizedMode === "demo" || normalizedMode === "dry" || normalizedMode === "dry-run") {
    mode = "demo";
  } else if (normalizedMode === "live") {
    mode = "live";
  } else if (demoFlag === true || dryRunFlag === true) {
    mode = "demo";
  }

  return {
    mode,
    isDemo: mode === "demo",
    isLive: mode === "live",
    label: mode === "demo" ? "DEMO" : "LIVE",
    legacyDryRun: mode === "demo",
  };
}

export function applyExecutionMode(options = {}) {
  const resolved = resolveExecutionMode(options);
  process.env.EXECUTION_MODE = resolved.mode;
  process.env.DEMO_MODE = String(resolved.isDemo);
  process.env.DRY_RUN = String(resolved.legacyDryRun);
  return resolved;
}
