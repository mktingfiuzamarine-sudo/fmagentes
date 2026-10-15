import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";
import type { Queue } from "bullmq";
import type { InboundJobData } from "@fmagentes/messaging";
import { registerHealthRoute } from "./routes/health";
import { registerWebhookRoute } from "./routes/webhooks";
import { registerInstanceRoutes } from "./routes/instances";
import { registerConversationRoutes } from "./routes/conversations";
import type { DashboardStore } from "./dashboard/store";
import { createSupabaseDashboardStore } from "./dashboard/supabaseStore";
import type { CustomerNamePort } from "./dashboard/customerNames";
import { registerMeRoute } from "./routes/me";
import { createAuthPreHandler, type AuthPort } from "./auth";

export interface AppConfig {
  webhookSecret: string;
  publicWebhookUrl: string;
  /** Emails or user ids permitted to call the consumer routes. Empty = deny all. */
  allowedUsers: string[];
  /** Which LLM keys the API has; assumed equal to the worker's. */
  providers?: { anthropic: boolean; openai: boolean };
}

export interface AppDependencies {
  redis: Redis;
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
  inboundQueue: Queue<InboundJobData>;
  auth: AuthPort;
  config: AppConfig;
  /** Defaults to the Supabase store over `supabase`. */
  dashboard?: DashboardStore;
  /** Absent when the CRM env vars are not set. */
  customerNames?: CustomerNamePort;
}

export function dashboardStore(deps: AppDependencies): DashboardStore {
  return deps.dashboard ?? createSupabaseDashboardStore(deps.supabase);
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : undefined);
    } catch {
      done(null, undefined);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    reply.send(error);
  });

  // Public by design: /health is a probe, and the webhook carries its own
  // apikey credential (Evolution cannot hold a user session).
  registerHealthRoute(app, deps);
  registerWebhookRoute(app, deps);

  // Consumer routes live inside an encapsulated scope, so the auth hook covers
  // them by construction rather than by an exception list someone must maintain.
  app.register(async (scope) => {
    scope.addHook("preHandler", createAuthPreHandler(deps));
    registerInstanceRoutes(scope, deps);
    registerConversationRoutes(scope, deps);
    registerMeRoute(scope, deps);
  });

  return app;
}
