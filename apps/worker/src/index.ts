import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { TEST_QUEUE_NAME } from "@fmagentes/shared";
import { loadEnv } from "./env";
import { processTestQueueJob } from "./testQueueProcessor";

const env = loadEnv();

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(TEST_QUEUE_NAME, processTestQueueJob, { connection });

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

console.log("[worker] listening for jobs on", TEST_QUEUE_NAME);
