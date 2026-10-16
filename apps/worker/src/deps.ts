import type { Redis } from "ioredis";
import { createSupabaseClient, createEvolutionApiClient } from "@fmagentes/shared";
import type { RespondDeps } from "@fmagentes/messaging";
import { LlmResponder, createSupabaseCrm } from "@fmagentes/agent";
import type { Env } from "./env";
import { createRedisConversationLock } from "./redisConversationLock";

// Every database call runs while the job holds the conversation lock, whose
// heartbeat keeps renewing as long as the process lives: a hung request must
// fail the attempt, not block the conversation indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

export function createWorkerDeps(env: Env, connection: Redis, options: { requestTimeoutMs?: number } = {}): RespondDeps {
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const crm = createSupabaseCrm(
    createSupabaseClient({ url: env.CRM_SUPABASE_URL, serviceKey: env.CRM_SUPABASE_SERVICE_KEY, timeoutMs }),
    { agentUserId: env.CRM_AGENT_USER_ID },
  );

  return {
    supabase: createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY, timeoutMs }),
    evolutionApi: createEvolutionApiClient({
      baseUrl: env.EVOLUTION_API_URL,
      apiKey: env.EVOLUTION_API_KEY,
    }),
    responder: new LlmResponder({
      llm: { anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY },
      crm,
    }),
    // The CRM adapter also serves as messaging's read-only customer directory.
    customerDirectory: crm,
    conversationLock: createRedisConversationLock(connection),
    historyLimit: env.AGENT_HISTORY_LIMIT,
  };
}
