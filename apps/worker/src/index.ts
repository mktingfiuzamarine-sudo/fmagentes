import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { createSupabaseClient, createEvolutionApiClient } from "@fmagentes/shared";
import { EchoResponder, INBOUND_QUEUE_NAME, type RespondDeps } from "@fmagentes/messaging";
import { loadEnv } from "./env";
import { createInboundProcessor } from "./inboundProcessor";
import { createRedisConversationLock } from "./redisConversationLock";

const WORKER_CONCURRENCY = 5;

const env = loadEnv();

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const deps: RespondDeps = {
  supabase: createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY }),
  evolutionApi: createEvolutionApiClient({
    baseUrl: env.EVOLUTION_API_URL,
    apiKey: env.EVOLUTION_API_KEY,
  }),
  // Sub-project 4 swaps this one line for the LLM-backed responder.
  responder: new EchoResponder(),
  conversationLock: createRedisConversationLock(connection),
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

console.log(`[worker] listening on ${INBOUND_QUEUE_NAME} with concurrency ${WORKER_CONCURRENCY}`);
