import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const INBOUND_QUEUE_NAME = "inbound-messages";

export interface InboundJobData {
  messageId: string;
  conversationId: string;
  instanceId: string;
}

export function createInboundQueue(connection: Redis): Queue<InboundJobData> {
  return new Queue<InboundJobData>(INBOUND_QUEUE_NAME, { connection });
}
