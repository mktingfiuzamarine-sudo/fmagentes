import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";
import type { Queue } from "bullmq";
import type { InboundJobData } from "@fmagentes/messaging";
import { registerHealthRoute } from "./routes/health";
import { registerWebhookRoute } from "./routes/webhooks";

export interface AppConfig {
  webhookSecret: string;
  publicWebhookUrl: string;
}

export interface AppDependencies {
  redis: Redis;
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
  inboundQueue: Queue<InboundJobData>;
  config: AppConfig;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _request, reply) => {
    reply.send(error);
  });

  registerHealthRoute(app, deps);
  registerWebhookRoute(app, deps);

  return app;
}
