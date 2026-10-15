"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./browserApi";
import type { Me } from "./types";

let pending: Promise<Me> | null = null;

/** Forget the cached profile (call on sign-out so the next user is refetched). */
export function resetMe(): void {
  pending = null;
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    pending ??= apiFetch<Me>("/me");
    pending.then(setMe).catch(() => {
      pending = null;
    });
  }, []);
  return me;
}
