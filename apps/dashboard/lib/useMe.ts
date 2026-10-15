"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./browserApi";
import { POLL_INTERVAL_MS } from "./usePolling";
import type { Me } from "./types";

let pending: Promise<Me> | null = null;

/** Forget the cached profile (call on sign-out so the next user is refetched). */
export function resetMe(): void {
  pending = null;
}

function loadMe(): Promise<Me> {
  if (pending) return pending;
  const p = apiFetch<Me>("/me");
  pending = p;
  p.catch(() => {
    // A stale promise rejecting after resetMe() must not clear a newer one.
    if (pending === p) pending = null;
  });
  return p;
}

/** The signed-in profile; retries every 10 s (tab visible) until it loads. */
export function useMe(): { me: Me | null; error: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const attempt = () => {
      loadMe().then(
        (value) => {
          if (cancelled) return;
          setMe(value);
          setError(false);
          if (timer) clearInterval(timer);
          timer = null;
        },
        () => {
          if (!cancelled) setError(true);
        },
      );
    };

    attempt();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") attempt();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return { me, error };
}
