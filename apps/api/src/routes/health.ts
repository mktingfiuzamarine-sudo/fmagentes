import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";

export function registerHealthRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.get("/health", async (_request, reply) => {
    const [supabaseOk, redisOk, evolutionOk] = await Promise.all([
      checkSupabase(deps),
      checkRedis(deps),
      checkEvolutionApi(deps),
    ]);

    const allOk = supabaseOk && redisOk && evolutionOk;

    reply.code(allOk ? 200 : 503).send({
      supabase: supabaseOk ? "connected" : "unavailable",
      redis: redisOk ? "connected" : "unavailable",
      evolutionApi: evolutionOk ? "connected" : "unavailable",
    });
  });
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
