import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { createTestQueue, TEST_QUEUE_NAME, type TestQueueJobData } from "@fmagentes/shared";

describe("end-to-end: api enqueues, worker processes", () => {
  let producerRedis: Redis;
  let workerRedis: Redis;
  let worker: Worker<TestQueueJobData>;

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

  it("processes a job enqueued through the shared test queue", async () => {
    const processed: string[] = [];

    workerRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
    worker = new Worker<TestQueueJobData>(
      TEST_QUEUE_NAME,
      async (job) => {
        processed.push(job.data.message);
        return { ok: true };
      },
      { connection: workerRedis }
    );

    await new Promise<void>((resolve) => worker.on("ready", resolve));

    const queue = createTestQueue(producerRedis);
    await queue.add("e2e-test-job", { message: "ping" });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for job to process")), 5000);
      worker.on("completed", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(processed).toEqual(["ping"]);
    await queue.close();
  }, 10000);
});
