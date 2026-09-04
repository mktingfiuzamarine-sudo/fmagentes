import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { InboundJobData } from "@fmagentes/messaging";
import { processInboundJob } from "../src/inboundProcessor";

describe("processInboundJob", () => {
  it("logs the message id and returns ok", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = { id: "j1", data: { messageId: "m1", conversationId: "c1", instanceId: "i1" } } as Job<InboundJobData>;

    const result = await processInboundJob(job);

    expect(result).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("m1"));
    logSpy.mockRestore();
  });
});
