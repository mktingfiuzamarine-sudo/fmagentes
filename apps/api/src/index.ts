import { Redis } from "ioredis";
import { createSupabaseClient, createEvolutionApiClient } from "@fmagentes/shared";
import { createInboundQueue } from "@fmagentes/messaging";
import { buildApp } from "./app";
import { createSupabaseCustomerNames } from "./dashboard/customerNames";
import { createSupabaseAuthPort } from "./auth";
import { loadEnv, parseTrustProxy } from "./env";

const env = loadEnv();

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
// Every client gets a timeout: a hung fetch would otherwise hold the request forever.
const SUPABASE_TIMEOUT_MS = 10_000;
const supabase = createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY, timeoutMs: SUPABASE_TIMEOUT_MS });
const evolutionApi = createEvolutionApiClient({ baseUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY });
const inboundQueue = createInboundQueue(redis);

// Token verification runs on a separate anon-key client: the service-key client
// above bypasses auth entirely and would never reject a caller's token.
const auth = createSupabaseAuthPort(
  createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_ANON_KEY, timeoutMs: SUPABASE_TIMEOUT_MS }),
);

const allowedUsers = env.API_ALLOWED_USERS.split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

if (allowedUsers.length === 0) {
  throw new Error("API_ALLOWED_USERS is set but lists no usable entry — every request would be rejected with 403.");
}

const customerNames =
  env.CRM_SUPABASE_URL && env.CRM_SUPABASE_SERVICE_KEY
    ? createSupabaseCustomerNames(
        createSupabaseClient({ url: env.CRM_SUPABASE_URL, serviceKey: env.CRM_SUPABASE_SERVICE_KEY, timeoutMs: SUPABASE_TIMEOUT_MS }),
      )
    : undefined;

const app = buildApp({
  redis,
  supabase,
  evolutionApi,
  inboundQueue,
  auth,
  customerNames,
  config: {
    webhookSecret: env.WEBHOOK_SECRET,
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL,
    allowedUsers,
    trustProxy: parseTrustProxy(env.API_TRUST_PROXY),
    providers: {
      anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      openai: Boolean(env.OPENAI_API_KEY?.trim()),
    },
  },
});

if (Boolean(env.CRM_SUPABASE_URL) !== Boolean(env.CRM_SUPABASE_SERVICE_KEY)) {
  app.log.warn("CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_KEY must both be set; customer names are disabled");
}

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
