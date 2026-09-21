import { Queue, type DefaultJobOptions } from "bullmq";
import type { Redis } from "ioredis";

export const INBOUND_QUEUE_NAME = "inbound-messages";

export interface InboundJobData {
  messageId: string;
  conversationId: string;
  instanceId: string;
}

/**
 * Retry policy lives on the producer so there is exactly one place to change
 * it. Three attempts with exponential backoff covers a transient Supabase or
 * Evolution failure; the duplicate guard in respondToInboundMessage is what
 * makes those retries safe.
 */
export const INBOUND_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export function createInboundQueue(connection: Redis): Queue<InboundJobData> {
  return new Queue<InboundJobData>(INBOUND_QUEUE_NAME, {
    connection,
    defaultJobOptions: INBOUND_JOB_OPTIONS,
  });
}
