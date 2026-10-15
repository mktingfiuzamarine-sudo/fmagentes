"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
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
  }, [key, intervalMs, hiddenIntervalMs, refresh]);

  return { data, error, refresh };
}
