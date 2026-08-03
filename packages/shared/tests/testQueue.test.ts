import { describe, expect, it, vi } from "vitest";

const { QueueMock } = vi.hoisted(() => ({
  QueueMock: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: QueueMock,
}));

import { createTestQueue, TEST_QUEUE_NAME } from "../src/testQueue";

describe("createTestQueue", () => {
  it("creates a BullMQ Queue named test-queue with the given connection", () => {
    const connection = { host: "localhost", port: 6379 };

    createTestQueue(connection as never);

    expect(QueueMock).toHaveBeenCalledWith(TEST_QUEUE_NAME, { connection });
    expect(TEST_QUEUE_NAME).toBe("test-queue");
  });
});
