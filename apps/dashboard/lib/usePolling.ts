"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createGeneration } from "./generation";

export const POLL_INTERVAL_MS = 10_000;

export interface PollingOptions {
  /** When set, keep polling at this interval while the tab is hidden instead of pausing. */
  hiddenIntervalMs?: number;
}

/**
 * Loads now, then every `intervalMs` while the tab is visible, and again when
 * it becomes visible. `key` restarts the cycle (e.g. a different tab or id).
 * With `hiddenIntervalMs` it also polls (more slowly) while the tab is hidden.
 */
export function usePolling<T>(
  load: () => Promise<T>,
  key: string,
  intervalMs = POLL_INTERVAL_MS,
  options: PollingOptions = {},
) {
  const { hiddenIntervalMs } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(createGeneration()).current;

  const refresh = useCallback(async () => {
    // A slow answer for the previous key must not overwrite the new key's data.
    const started = generation.current();
    try {
      const loaded = await loadRef.current();
      if (!generation.isCurrent(started)) return;
      setData(loaded);
      setError(null);
    } catch (caught) {
      if (generation.isCurrent(started)) setError(caught);
    }
  }, [generation]);

  useEffect(() => {
    generation.advance();
    setData(null);
    let lastRun = Date.now();
    const run = () => {
      lastRun = Date.now();
      void refresh();
    };
    run();
    const tick = hiddenIntervalMs === undefined ? intervalMs : Math.min(intervalMs, hiddenIntervalMs);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") run();
      else if (hiddenIntervalMs !== undefined && Date.now() - lastRun >= hiddenIntervalMs) run();
    }, tick);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, intervalMs, hiddenIntervalMs, refresh, generation]);

  return { data, error, refresh };
}
