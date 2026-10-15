"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./browserApi";
import type { Me } from "./types";

let pending: Promise<Me> | null = null;

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
