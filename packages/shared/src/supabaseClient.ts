import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
  /** Abort any request that takes longer than this. No timeout when omitted. */
  timeoutMs?: number;
}

/** A fetch that aborts after `timeoutMs`, on top of any signal the caller passes. */
export function fetchWithTimeout(timeoutMs: number, baseFetch: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const signals = [init?.signal, AbortSignal.timeout(timeoutMs)].filter(
      (signal): signal is AbortSignal => signal != null,
    );
    return baseFetch(input, { ...init, signal: AbortSignal.any(signals) });
  };
}

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    ...(config.timeoutMs !== undefined && { global: { fetch: fetchWithTimeout(config.timeoutMs) } }),
  });
}
