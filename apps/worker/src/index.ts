import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { INBOUND_QUEUE_NAME } from "@fmagentes/messaging";
import { loadEnv } from "./env";
import { processInboundJob } from "./inboundProcessor";

const env = loadEnv();

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(INBOUND_QUEUE_NAME, processInboundJob, { connection });

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

console.log("[worker] listening for jobs on", INBOUND_QUEUE_NAME);
