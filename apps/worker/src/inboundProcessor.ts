import type { Job } from "bullmq";
import type { InboundJobData } from "@fmagentes/messaging";

export async function processInboundJob(job: Job<InboundJobData>): Promise<{ ok: true }> {
  console.log(`[worker] inbound job ${job.id} for message ${job.data.messageId} (conversation ${job.data.conversationId})`);
  return { ok: true };
}
