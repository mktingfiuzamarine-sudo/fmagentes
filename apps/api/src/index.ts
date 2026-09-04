import { Redis } from "ioredis";
import { createSupabaseClient, createEvolutionApiClient, createTestQueue } from "@fmagentes/shared";
import { buildApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const supabase = createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
const evolutionApi = createEvolutionApiClient({ baseUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY });
const testQueue = createTestQueue(redis);

const app = buildApp({
  redis,
  supabase,
  evolutionApi,
  testQueue,
  config: { webhookSecret: env.WEBHOOK_SECRET, publicWebhookUrl: env.PUBLIC_WEBHOOK_URL },
});

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
