import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";

export interface MessagingDeps {
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
}
