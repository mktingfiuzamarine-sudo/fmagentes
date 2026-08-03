import type { FastifyInstance } from "fastify";

export function registerWebhookRoute(app: FastifyInstance): void {
  app.post("/webhooks/evolution", async (request, reply) => {
    app.log.info({ body: request.body }, "Received Evolution API webhook");
    reply.code(200).send({ received: true });
  });
}
