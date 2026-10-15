import type { FastifyInstance } from "fastify";
import { dashboardStore, type AppDependencies } from "../app";

const NO_PROVIDERS = { anthropic: false, openai: false };

export function registerMeRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.get("/me", async (request) => {
    const user = request.user!;
    const names = await dashboardStore(deps).displayNames([user.id]);
    return {
      id: user.id,
      email: user.email,
      displayName: names.get(user.id) ?? user.email ?? user.id,
      providers: deps.config.providers ?? NO_PROVIDERS,
    };
  });
}
