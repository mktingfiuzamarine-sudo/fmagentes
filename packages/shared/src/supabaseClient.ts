import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
