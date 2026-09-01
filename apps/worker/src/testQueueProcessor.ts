import type { Job } from "bullmq";
import type { TestQueueJobData } from "@fmagentes/shared";

export async function processTestQueueJob(job: Job<TestQueueJobData>): Promise<{ ok: true }> {
  console.log(`[worker] processed job ${job.id}: ${job.data.message}`);
  return { ok: true };
}
