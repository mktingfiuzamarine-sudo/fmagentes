import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";
import type { Queue } from "bullmq";
import { registerHealthRoute } from "./routes/health";
import { registerWebhookRoute } from "./routes/webhooks";
import { registerTestQueueRoute } from "./routes/testQueue";

export interface AppConfig {
  webhookSecret: string;
  publicWebhookUrl: string;
}

export interface AppDependencies {
  redis: Redis;
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
  testQueue: Queue;
  config: AppConfig;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, request, reply) => {
    if (request.routeOptions.url === "/webhooks/evolution") {
      app.log.warn({ err: error }, "Malformed Evolution API webhook payload");
      reply.code(200).send({ received: false });
      return;
    }

    reply.send(error);
  });

  registerHealthRoute(app, deps);
  registerWebhookRoute(app, deps);
  registerTestQueueRoute(app, deps);

  return app;
}
