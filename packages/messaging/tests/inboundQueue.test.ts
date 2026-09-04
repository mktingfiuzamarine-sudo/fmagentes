import { describe, expect, it, vi } from "vitest";

const { QueueMock } = vi.hoisted(() => ({ QueueMock: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: QueueMock }));

import { createInboundQueue, INBOUND_QUEUE_NAME } from "../src/inboundQueue";

describe("createInboundQueue", () => {
  it("creates a BullMQ Queue named inbound-messages with the connection", () => {
    const connection = { host: "localhost", port: 6379 };
    createInboundQueue(connection as never);
    expect(QueueMock).toHaveBeenCalledWith(INBOUND_QUEUE_NAME, { connection });
    expect(INBOUND_QUEUE_NAME).toBe("inbound-messages");
  });
});
