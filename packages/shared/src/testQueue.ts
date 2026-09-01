import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const TEST_QUEUE_NAME = "test-queue";

export interface TestQueueJobData {
  message: string;
}

export function createTestQueue(connection: Redis): Queue<TestQueueJobData> {
  return new Queue<TestQueueJobData>(TEST_QUEUE_NAME, { connection });
}
