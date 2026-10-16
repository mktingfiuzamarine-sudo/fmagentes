import { describe, expect, it, vi } from "vitest";
import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { ConversationBusyError, ResponderConfigurationError, type InboundJobData } from "@fmagentes/messaging";
import { createInboundProcessor } from "../src/inboundProcessor";

const DATA: InboundJobData = { messageId: "m1", conversationId: "c1", instanceId: "i1" };

function job({ attemptsMade = 0, attempts = 3 } = {}): Job<InboundJobData> & { moveToDelayed: ReturnType<typeof vi.fn> } {
  return {
    id: "j1",
    data: DATA,
    attemptsMade,
    opts: { attempts },
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

describe("hand-off when a job fails for good", () => {
  const handOff = () => vi.fn(async () => ({ status: "handoff" as const, messageId: "notice" }));
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("hands a misconfigured agent's conversation to a human, then fails permanently", async () => {
    const logged = quiet();
    const fallback = handOff();
    const respond = vi.fn(async () => {
      throw new ResponderConfigurationError("agent-9", "LLM rejected agent agent-9 with HTTP 400: credit balance is too low");
    });
    const process = createInboundProcessor({ marker: "deps" } as never, { respond: respond as never, handOff: fallback });

    await expect(process(job(), "tok")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fallback).toHaveBeenCalledWith({ marker: "deps" }, DATA, expect.stringContaining("configura"));
    logged.mockRestore();
  });

  it("hands off on the last attempt of an ordinary failure", async () => {
    const logged = quiet();
    const fallback = handOff();
    const respond = vi.fn(async () => {
      throw new Error("anthropic overloaded");
    });
    const process = createInboundProcessor({} as never, { respond: respond as never, handOff: fallback });

    await expect(process(job({ attemptsMade: 2, attempts: 3 }), "tok")).rejects.toThrow("anthropic overloaded");
    expect(fallback).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("does not hand off while BullMQ still has attempts left", async () => {
    const fallback = handOff();
    const respond = vi.fn(async () => {
      throw new Error("anthropic overloaded");
    });
    const process = createInboundProcessor({} as never, { respond: respond as never, handOff: fallback });

    await expect(process(job({ attemptsMade: 1, attempts: 3 }), "tok")).rejects.toThrow("anthropic overloaded");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("keeps the original error when the hand-off itself fails", async () => {
    const logged = quiet();
    const fallback = vi.fn(async () => {
      throw new Error("evolution down");
    });
    const respond = vi.fn(async () => {
      throw new Error("anthropic overloaded");
    });
    const process = createInboundProcessor({} as never, { respond: respond as never, handOff: fallback as never });

    await expect(process(job({ attemptsMade: 2, attempts: 3 }), "tok")).rejects.toThrow("anthropic overloaded");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("hand-off"), expect.any(Error));
    logged.mockRestore();
  });
});
