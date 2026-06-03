import { useCallback, useState } from "react";
import { readState } from "../data/readState.js";
import { useInterval } from "./useInterval.js";
import type { AgentState } from "../types.js";

interface StateResult {
  state: AgentState | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Poll the bot state from disk on an interval. Fails soft to an error string. */
export function usePonyouState(intervalMs = 1500): StateResult {
  const [state, setState] = useState<AgentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    try {
      setState(readState());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial read + polling.
  useInterval(refresh, intervalMs);
  if (loading && state === null && error === null) {
    // Kick the first read synchronously on mount-equivalent.
    queueMicrotask(refresh);
  }

  return { state, loading, error, refresh };
}
