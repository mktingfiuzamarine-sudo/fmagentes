import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";
import type { ResponderPort } from "./responder";
import type { ConversationLock } from "./conversationLock";

export interface MessagingDeps {
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
  /** Required only by respondToInboundMessage — see RespondDeps. */
  responder?: ResponderPort;
  /** Required only by respondToInboundMessage — see RespondDeps. */
  conversationLock?: ConversationLock;
}
