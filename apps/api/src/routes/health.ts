import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";

/** How long one probe of the dependencies answers every /health call. */
export const HEALTH_CACHE_MS = 5000;

interface HealthReport {
  supabase: "connected" | "unavailable";
  redis: "connected" | "unavailable";
  evolutionApi: "connected" | "unavailable";
}

export function registerHealthRoute(app: FastifyInstance, deps: AppDependencies, perMinute: number): void {
  // Public and unauthenticated: share one probe between callers (in flight or
  // recent) so /health cannot be used to hammer Supabase and Evolution.
  let cached: { at: number; report: Promise<HealthReport> } | null = null;

  app.get(
    "/health",
    { config: { rateLimit: { max: perMinute, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      if (!cached || Date.now() - cached.at >= HEALTH_CACHE_MS) {
        cached = { at: Date.now(), report: probe(deps) };
      }
      const report = await cached.report;
      const allOk = Object.values(report).every((status) => status === "connected");
      reply.code(allOk ? 200 : 503).send(report);
    },
  );
}

async function probe(deps: AppDependencies): Promise<HealthReport> {
  const [supabaseOk, redisOk, evolutionOk] = await Promise.all([
    checkSupabase(deps),
    checkRedis(deps),
    checkEvolutionApi(deps),
  ]);
  return {
    supabase: supabaseOk ? "connected" : "unavailable",
    redis: redisOk ? "connected" : "unavailable",
    evolutionApi: evolutionOk ? "connected" : "unavailable",
  };
}

async function checkSupabase(deps: AppDependencies): Promise<boolean> {
  try {
    const { error } = await deps.supabase.from("instances").select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}

async function checkRedis(deps: AppDependencies): Promise<boolean> {
  try {
    const pong = await deps.redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

async function checkEvolutionApi(deps: AppDependencies): Promise<boolean> {
  return deps.evolutionApi.checkConnection();
}
