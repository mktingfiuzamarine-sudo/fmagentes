import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";

export function registerTestQueueRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/test/enqueue", async (_request, reply) => {
    const job = await deps.testQueue.add("test-job", { message: "hello from api" });
    reply.code(202).send({ jobId: job.id });
  });
}
