import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";

export function registerWebhookRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/webhooks/evolution", async (request, reply) => {
    if (request.headers.apikey !== deps.config.webhookSecret) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    app.log.info({ body: request.body }, "Received Evolution API webhook");
    return reply.code(200).send({ received: true });
  });
}
