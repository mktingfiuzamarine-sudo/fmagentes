import { describe, expect, it, vi } from "vitest";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { ConversationBusyError, ResponderConfigurationError, type InboundJobData } from "@fmagentes/messaging";
import { createInboundProcessor } from "../src/inboundProcessor";

const DATA: InboundJobData = { messageId: "m1", conversationId: "c1", instanceId: "i1" };

function job(): Job<InboundJobData> & { moveToDelayed: ReturnType<typeof vi.fn> } {
  return {
    id: "j1",
    data: DATA,
    moveToDelayed: vi.fn(async () => {}),
  } as never;
}

describe("createInboundProcessor", () => {
  it("delegates to respondToInboundMessage and returns its result", async () => {
    const respond = vi.fn(async () => ({ status: "sent", messageId: "msg-out" }));
    const process = createInboundProcessor({} as never, { respond: respond as never });

    await expect(process(job(), "tok")).resolves.toEqual({ status: "sent", messageId: "msg-out" });
    expect(respond).toHaveBeenCalledWith({}, DATA);
  });

  it("reschedules instead of failing when the conversation is busy", async () => {
    const respond = vi.fn(async () => {
      throw new ConversationBusyError("c1");
    });
    const j = job();
    const process = createInboundProcessor({} as never, {
      respond: respond as never,
      retryDelayMs: 2000,
    });

    await expect(process(j, "tok")).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledOnce();
    const [timestamp, token] = j.moveToDelayed.mock.calls[0];
    expect(token).toBe("tok");
    expect(timestamp).toBeGreaterThan(Date.now());
  });

  it("propagates any other error so BullMQ retries", async () => {
    const respond = vi.fn(async () => {
      throw new Error("supabase down");
    });
    const process = createInboundProcessor({} as never, { respond: respond as never });

    await expect(process(job(), "tok")).rejects.toThrow("supabase down");
  });

  it("fails a misconfigured agent permanently and names the agent", async () => {
    const respond = vi.fn(async () => {
      throw new ResponderConfigurationError("agent-9", "LLM rejected agent agent-9 with HTTP 401");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const process = createInboundProcessor({} as never, { respond: respond as never });

    await expect(process(job(), "tok")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("agent-9"));
    logged.mockRestore();
  });
});
