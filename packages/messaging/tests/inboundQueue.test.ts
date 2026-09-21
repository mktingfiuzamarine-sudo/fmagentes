import { describe, expect, it, vi } from "vitest";

const { QueueMock } = vi.hoisted(() => ({ QueueMock: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: QueueMock }));

import { createInboundQueue, INBOUND_QUEUE_NAME, INBOUND_JOB_OPTIONS } from "../src/inboundQueue";

describe("createInboundQueue", () => {
  it("creates a BullMQ Queue named inbound-messages with the connection and default job options", () => {
    const connection = { host: "localhost", port: 6379 };
    createInboundQueue(connection as never);
    expect(QueueMock).toHaveBeenCalledWith(INBOUND_QUEUE_NAME, {
      connection,
      defaultJobOptions: INBOUND_JOB_OPTIONS,
    });
    expect(INBOUND_QUEUE_NAME).toBe("inbound-messages");
  });
});

describe("INBOUND_JOB_OPTIONS", () => {
  it("retries three times with exponential backoff", () => {
    expect(INBOUND_JOB_OPTIONS.attempts).toBe(3);
    expect(INBOUND_JOB_OPTIONS.backoff).toEqual({ type: "exponential", delay: 1000 });
  });

  it("caps how many finished jobs are retained", () => {
    expect(INBOUND_JOB_OPTIONS.removeOnComplete).toEqual({ count: 1000 });
    expect(INBOUND_JOB_OPTIONS.removeOnFail).toEqual({ count: 5000 });
  });
});
