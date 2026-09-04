import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { createInboundQueue, INBOUND_QUEUE_NAME, type InboundJobData } from "@fmagentes/messaging";

describe("end-to-end: api enqueues, worker processes", () => {
  let producerRedis: Redis;
  let workerRedis: Redis;
  let worker: Worker<InboundJobData>;

  beforeAll(() => {
    producerRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    if (worker) {
      await worker.close();
    }
    if (workerRedis) {
      await workerRedis.quit();
    }
    if (producerRedis) {
      await producerRedis.quit();
    }
  });

  it("processes a job enqueued through the inbound-messages queue", async () => {
    const processed: string[] = [];

    workerRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
    worker = new Worker<InboundJobData>(
      INBOUND_QUEUE_NAME,
      async (job) => {
        processed.push(job.data.messageId);
        return { ok: true };
      },
      { connection: workerRedis }
    );

    await new Promise<void>((resolve) => worker.on("ready", resolve));

    // Bind the completion listener before enqueuing: queue.add() resolves as
    // soon as the job is in Redis, and a fast worker could finish it before a
    // listener attached afterwards — losing the event and hanging the test.
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for job to process")), 5000);
      worker.on("completed", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const queue = createInboundQueue(producerRedis);
    await queue.add(INBOUND_QUEUE_NAME, { messageId: "msg-e2e", conversationId: "conv-e2e", instanceId: "inst-e2e" });

    await completed;

    expect(processed).toEqual(["msg-e2e"]);
    await queue.close();
  }, 10000);
});
