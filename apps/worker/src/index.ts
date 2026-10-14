import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { createSupabaseClient, createEvolutionApiClient } from "@fmagentes/shared";
import { INBOUND_QUEUE_NAME, type RespondDeps } from "@fmagentes/messaging";
import { LlmResponder, createSupabaseCrm } from "@fmagentes/agent";
import { llmKeyWarning, loadEnv } from "./env";
import { createInboundProcessor } from "./inboundProcessor";
import { createRedisConversationLock } from "./redisConversationLock";

const WORKER_CONCURRENCY = 5;
// The CRM is reached mid-conversation (inside the model's tool calls): a hung
// request must fail the attempt, not hold the conversation lock indefinitely.
const CRM_REQUEST_TIMEOUT_MS = 10_000;

const env = loadEnv();

const missingKey = llmKeyWarning(env);
if (missingKey) console.warn(missingKey);

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const crm = createSupabaseCrm(
  createSupabaseClient({
    url: env.CRM_SUPABASE_URL,
    serviceKey: env.CRM_SUPABASE_SERVICE_KEY,
    timeoutMs: CRM_REQUEST_TIMEOUT_MS,
  }),
  { agentUserId: env.CRM_AGENT_USER_ID },
);

const deps: RespondDeps = {
  supabase: createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY }),
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

const worker = new Worker(INBOUND_QUEUE_NAME, createInboundProcessor(deps), {
  connection,
  concurrency: WORKER_CONCURRENCY,
});

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, shutting down`);
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[worker] listening on ${INBOUND_QUEUE_NAME} with concurrency ${WORKER_CONCURRENCY}`);
