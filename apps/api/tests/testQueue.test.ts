import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";

describe("POST /test/enqueue", () => {
  it("enqueues a job and returns its id", async () => {
    const addMock = vi.fn().mockResolvedValue({ id: "job-123" });
    const deps: AppDependencies = {
      redis: {} as never,
      supabase: {} as never,
      evolutionApi: {} as never,
      testQueue: { add: addMock } as never,
    };
    const app = buildApp(deps);

    const response = await app.inject({ method: "POST", url: "/test/enqueue" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ jobId: "job-123" });
    expect(addMock).toHaveBeenCalledWith("test-job", { message: "hello from api" });

    await app.close();
  });
});
