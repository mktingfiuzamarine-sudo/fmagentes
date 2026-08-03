import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";
import type { Queue } from "bullmq";
import { registerHealthRoute } from "./routes/health";
import { registerWebhookRoute } from "./routes/webhooks";

export interface AppDependencies {
  redis: Redis;
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
  testQueue: Queue;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, request, reply) => {
    if (request.url === "/webhooks/evolution") {
      app.log.warn({ err: error }, "Malformed Evolution API webhook payload");
      reply.code(200).send({ received: false });
      return;
    }

    reply.send(error);
  });

  registerHealthRoute(app, deps);
  registerWebhookRoute(app);

  return app;
}
