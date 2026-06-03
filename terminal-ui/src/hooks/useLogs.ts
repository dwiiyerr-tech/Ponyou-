import { useState } from "react";
import { readRecentLogs } from "../data/readLogs.js";
import { useInterval } from "./useInterval.js";
import type { LogLine } from "../types.js";

/** Poll the tail of the bot log. Returns newest-last lines. */
export function useLogs(limit = 200, intervalMs = 1000): { logs: LogLine[]; loaded: boolean } {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [loaded, setLoaded] = useState(false);

  useInterval(() => {
    setLogs(readRecentLogs(limit));
    setLoaded(true);
  }, intervalMs);

  if (!loaded && logs.length === 0) {
    queueMicrotask(() => { setLogs(readRecentLogs(limit)); setLoaded(true); });
  }

  return { logs, loaded };
}
