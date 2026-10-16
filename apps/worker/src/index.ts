import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { INBOUND_QUEUE_NAME } from "@fmagentes/messaging";
import { createWorkerDeps } from "./deps";
import { llmKeyWarning, loadEnv } from "./env";
import { createInboundProcessor } from "./inboundProcessor";

const WORKER_CONCURRENCY = 5;

const env = loadEnv();

const missingKey = llmKeyWarning(env);
if (missingKey) console.warn(missingKey);

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const deps = createWorkerDeps(env, connection);

const worker = new Worker(INBOUND_QUEUE_NAME, createInboundProcessor(deps), {
  connection,
  concurrency: WORKER_CONCURRENCY,
});

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, shutting down`);
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[worker] listening on ${INBOUND_QUEUE_NAME} with concurrency ${WORKER_CONCURRENCY}`);
