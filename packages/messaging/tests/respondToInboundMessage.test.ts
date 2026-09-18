import { describe, expect, it, vi } from "vitest";
import { respondToInboundMessage } from "../src/respondToInboundMessage";
import { ConversationBusyError } from "../src/conversationLock";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const JOB = { messageId: "msg-in", conversationId: "conv-1", instanceId: "inst-1" };

const INBOUND_ROW = {
  id: "msg-in",
  conversation_id: "conv-1",
  content: "ola",
  created_at: "2026-09-17T10:00:00Z",
  conversations: { id: "conv-1", instance_id: "inst-1", agent_id: "agent-1" },
};

const AGENT_ROW = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-opus-5",
  system_prompt: "Seja breve.",
};

interface Options {
  inbound?: unknown;
  agent?: unknown;
  newerOutbound?: unknown;
  reply?: string | null;
  lockBusy?: boolean;
  messagesError?: unknown;
  sendText?: ReturnType<typeof vi.fn>;
}

function build(options: Options = {}) {
  const release = vi.fn(async () => {});
  const supabase = createSupabaseMock({
    messages: (calls: TableCall) => {
      if (options.messagesError) return { data: null, error: options.messagesError };
      // The duplicate guard is the only query filtering on direction=out.
      const isGuard = calls.some((c) => c.op === "gt");
      if (isGuard) return { data: options.newerOutbound ?? null, error: null };
      // The history query orders; the inbound lookup does not.
      const isHistory = calls.some((c) => c.op === "order");
      if (isHistory) {
        return { data: [{ direction: "in", content: "ola", created_at: "2026-09-17T10:00:00Z" }], error: null };
      }
      if (calls.some((c) => c.op === "insert")) {
        return {
          data: { id: "msg-out", conversation_id: "conv-1", direction: "out", content: "Echo: ola", created_at: "2026-09-17T10:00:05Z" },
          error: null,
        };
      }
      return { data: options.inbound === undefined ? INBOUND_ROW : options.inbound, error: null };
    },
    agents: () => ({ data: options.agent === undefined ? AGENT_ROW : options.agent, error: null }),
    conversations: () => ({
      data: { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } },
      error: null,
    }),
  });

  const responder = {
    generate: vi.fn(async () => (options.reply === undefined ? "Echo: ola" : options.reply)),
  };
  const conversationLock = {
    acquire: vi.fn(async () => (options.lockBusy ? null : { release })),
  };
  const evolutionApi = {
    sendText: options.sendText ?? vi.fn().mockResolvedValue({ messageId: "EVO1" }),
  };

  return { deps: { supabase, evolutionApi, responder, conversationLock } as never, responder, conversationLock, release, evolutionApi };
}

describe("respondToInboundMessage", () => {
  it("generates a reply and sends it", async () => {
    const { deps, responder, release } = build();

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "sent", messageId: "msg-out" });
    expect(responder.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "agent-1", systemPrompt: "Seja breve." }),
        incoming: { role: "user", content: "ola", createdAt: "2026-09-17T10:00:00Z" },
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("throws ConversationBusyError when the lock is held", async () => {
    const { deps, responder } = build({ lockBusy: true });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toBeInstanceOf(ConversationBusyError);
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("skips when the inbound message no longer exists", async () => {
    const { deps } = build({ inbound: null });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({
      status: "skipped",
      reason: "message-not-found",
    });
  });

  it("skips when there is no active agent", async () => {
    const { deps, responder } = build({ agent: null });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({
      status: "skipped",
      reason: "no-active-agent",
    });
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("skips when a newer outbound message already answered", async () => {
    const { deps, responder } = build({ newerOutbound: { id: "msg-out-old" } });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({
      status: "skipped",
      reason: "already-answered",
    });
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("skips when the responder declines", async () => {
    const { deps, evolutionApi } = build({ reply: null });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({
      status: "skipped",
      reason: "responder-declined",
    });
    expect(evolutionApi.sendText).not.toHaveBeenCalled();
  });

  it("releases the lock when a step throws", async () => {
    const { deps, release } = build({ messagesError: { message: "boom" } });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates an Evolution failure so BullMQ retries", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("evolution timeout"));
    const { deps } = build({ sendText });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toThrow("evolution timeout");
  });
});
