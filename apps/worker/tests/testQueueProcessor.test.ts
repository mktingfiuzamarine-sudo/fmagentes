import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { TestQueueJobData } from "@fmagentes/shared";
import { processTestQueueJob } from "../src/testQueueProcessor";

describe("processTestQueueJob", () => {
  it("logs the job message and returns ok", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = { id: "job-1", data: { message: "hello" } } as Job<TestQueueJobData>;

    const result = await processTestQueueJob(job);

    expect(result).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("hello"));

    logSpy.mockRestore();
  });
});
