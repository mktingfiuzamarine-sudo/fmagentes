import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
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
import { registerAgentRoutes } from "./routes/agents";
import { registerInboxRoutes } from "./routes/inbox";
import { createAuthPreHandler, type AuthPort } from "./auth";

export interface AppConfig {
  webhookSecret: string;
  publicWebhookUrl: string;
  /** Emails or user ids permitted to call the consumer routes. Empty = deny all. */
  allowedUsers: string[];
  /** Which LLM keys the API has; assumed equal to the worker's. */
  providers?: { anthropic: boolean; openai: boolean };
  /** Requests per client address per minute. Defaults to DEFAULT_RATE_LIMIT. */
  rateLimit?: { perMinute: number; healthPerMinute: number };
  /**
   * Fastify trustProxy: set when a reverse proxy (Traefik) fronts the API, so
   * limits count each client instead of the proxy. Never set it without one:
   * clients could then pick their own address via X-Forwarded-For.
   */
  trustProxy?: boolean | number | string;
}

/**
 * Sized for the dashboard, whose server proxies every attendant through one
 * address (each open tab polls about 20 times a minute), not for one person.
 */
export const DEFAULT_RATE_LIMIT = { perMinute: 600, healthPerMinute: 30 };

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
  const app = Fastify({ logger: true, trustProxy: deps.config.trustProxy ?? false });
  const limits = deps.config.rateLimit ?? DEFAULT_RATE_LIMIT;

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

  // Runs onRequest, before the auth preHandler, so a flood of bad tokens never
  // reaches Supabase Auth. Routes are declared in the plugin below, which loads
  // after this one: the limiter only sees routes added once it is in place.
  app.register(rateLimit, { max: limits.perMinute, timeWindow: "1 minute" });

  app.register(async (root) => {
    // Public by design: /health is a probe, and the webhook carries its own
    // apikey credential (Evolution cannot hold a user session).
    registerHealthRoute(root, deps, limits.healthPerMinute);
    registerWebhookRoute(root, deps);

    // Consumer routes live inside an encapsulated scope, so the auth hook covers
    // them by construction rather than by an exception list someone must maintain.
    root.register(async (scope) => {
      scope.addHook("preHandler", createAuthPreHandler(deps));
      registerInstanceRoutes(scope, deps);
      registerConversationRoutes(scope, deps);
      registerMeRoute(scope, deps);
      registerInboxRoutes(scope, deps);
      registerAgentRoutes(scope, deps);
    });
  });

  return app;
}
