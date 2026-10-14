import { describe, expect, it, vi } from "vitest";
import { respondToInboundMessage } from "../src/respondToInboundMessage";
import { ConversationBusyError, LockLostError } from "../src/conversationLock";
import type { ResponderResult } from "../src/responder";
import { createSupabaseMock } from "./support/supabaseMock";
import { AGENT, INBOUND, createFakeStore, type FakeStoreOptions } from "./support/fakeRespondStore";

const JOB = { messageId: "msg-in", conversationId: "conv-1", instanceId: "inst-1" };

interface Options {
  store?: FakeStoreOptions;
  result?: ResponderResult;
  lockBusy?: boolean;
  lockLost?: boolean;
  sendText?: ReturnType<typeof vi.fn>;
  conversationGone?: boolean;
  phoneMatch?: { id: string; name: string } | null;
  byId?: { id: string; name: string } | null;
  historyLimit?: number;
}

function build(options: Options = {}) {
  const store = createFakeStore(options.store);
  const release = vi.fn(async () => {});
  const conversationLock = {
    acquire: vi.fn(async () => (options.lockBusy ? null : { release, isLost: () => options.lockLost ?? false })),
  };
  const responder = {
    generate: vi.fn(async (): Promise<ResponderResult> => options.result ?? { kind: "reply", text: "Oi! Como posso ajudar?" }),
  };
  const customerDirectory = {
    findByPhone: vi.fn(async () => options.phoneMatch ?? null),
    findById: vi.fn(async () => options.byId ?? null),
  };
  // Only sendMessage still talks to Supabase directly: conversation lookup,
  // outbound insert, last_message_at update.
  const supabase = createSupabaseMock({
    conversations: () => ({
      data: options.conversationGone
        ? null
        : { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } },
      error: null,
    }),
    messages: () => ({
      data: { id: "msg-out", conversation_id: "conv-1", direction: "out", content: "x", created_at: "2026-10-14T12:00:05Z" },
      error: null,
    }),
  });
  const evolutionApi = { sendText: options.sendText ?? vi.fn().mockResolvedValue({ messageId: "EVO1" }) };

  const deps = {
    supabase,
    evolutionApi,
    responder,
    conversationLock,
    customerDirectory,
    store,
    historyLimit: options.historyLimit,
  } as never;
  return { deps, store, responder, release, evolutionApi, customerDirectory };
}

describe("respondToInboundMessage", () => {
  it("generates a reply and sends it", async () => {
    const { deps, responder, evolutionApi, release } = build();

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "sent", messageId: "msg-out" });
    expect(responder.generate).toHaveBeenCalledWith({
      agent: AGENT,
      history: [{ role: "user", content: "ola", createdAt: INBOUND.createdAt }],
      incoming: { role: "user", content: "ola", createdAt: INBOUND.createdAt },
      conversationId: "conv-1",
      contactPhone: "5511999998888",
      customer: { status: "unregistered" },
    });
    expect(evolutionApi.sendText).toHaveBeenCalledWith("acme", "5511999998888", "Oi! Como posso ajudar?");
    expect(release).toHaveBeenCalledOnce();
  });

  it("throws ConversationBusyError when the lock is held", async () => {
    const { deps, responder, release } = build({ lockBusy: true });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toBeInstanceOf(ConversationBusyError);
    expect(responder.generate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("skips when the inbound message no longer exists", async () => {
    const { deps } = build({ store: { inbound: null } });
    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "message-not-found" });
  });

  it("skips when there is no active agent", async () => {
    const { deps, responder } = build({ store: { agent: null } });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "no-active-agent" });
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("guards duplicates with the database receipt time, not the device timestamp", async () => {
    const { deps, store, responder } = build({ store: { answered: true } });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "already-answered" });
    expect(store.hasOutboundAfter).toHaveBeenCalledWith("conv-1", INBOUND.receivedAt);
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("skips when the responder declines", async () => {
    const { deps, evolutionApi } = build({ result: { kind: "decline" } });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "responder-declined" });
    expect(evolutionApi.sendText).not.toHaveBeenCalled();
  });

  it("loads 30 history messages by default and honours historyLimit", async () => {
    const first = build();
    await respondToInboundMessage(first.deps, JOB);
    expect(first.store.loadHistory).toHaveBeenCalledWith("conv-1", 30);

    const second = build({ historyLimit: 5 });
    await respondToInboundMessage(second.deps, JOB);
    expect(second.store.loadHistory).toHaveBeenCalledWith("conv-1", 5);
  });

  it("releases the lock when a step throws", async () => {
    const { deps, store, release } = build();
    store.loadInbound.mockRejectedValueOnce(new Error("boom"));

    await expect(respondToInboundMessage(deps, JOB)).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates an Evolution failure so BullMQ retries", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("evolution timeout"));
    const { deps, release } = build({ sendText });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toThrow("evolution timeout");
    expect(release).toHaveBeenCalledOnce();
  });

  it("skips when the conversation vanishes before sending", async () => {
    const { deps, responder, evolutionApi } = build({ conversationGone: true });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "message-not-found" });
    expect(responder.generate).toHaveBeenCalledOnce();
    expect(evolutionApi.sendText).not.toHaveBeenCalled();
  });

  describe("handoff", () => {
    it("persists the handoff, then sends the agent's handoff message", async () => {
      const { deps, store, evolutionApi } = build({ result: { kind: "handoff", summary: "Quer orçamento de casco" } });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "handoff", messageId: "msg-out" });
      expect(store.markAwaitingHuman).toHaveBeenCalledWith("conv-1", {
        summary: "Quer orçamento de casco",
        handoffAt: INBOUND.receivedAt,
      });
      expect(evolutionApi.sendText).toHaveBeenCalledWith("acme", "5511999998888", AGENT.handoffMessage);
      expect(store.markAwaitingHuman.mock.invocationCallOrder[0]).toBeLessThan(
        evolutionApi.sendText.mock.invocationCallOrder[0],
      );
    });

    it("skips inbound received after the handoff without calling the model", async () => {
      const { deps, responder, evolutionApi } = build({
        store: {
          inbound: {
            conversationStatus: "awaiting_human",
            handoffAt: "2026-10-14T11:59:00.000Z",
            receivedAt: "2026-10-14T12:00:00.000Z",
          },
        },
      });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "awaiting-human" });
      expect(responder.generate).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });

    it("on retry of the triggering message, sends only the pending notice", async () => {
      const { deps, responder, evolutionApi } = build({
        store: { inbound: { conversationStatus: "awaiting_human", handoffAt: INBOUND.receivedAt } },
      });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "handoff", messageId: "msg-out" });
      expect(responder.generate).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).toHaveBeenCalledWith("acme", "5511999998888", AGENT.handoffMessage);
    });

    it("does not resend a notice that already went out", async () => {
      const { deps, evolutionApi } = build({
        store: { inbound: { conversationStatus: "awaiting_human", handoffAt: INBOUND.receivedAt }, answered: true },
      });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "already-answered" });
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });

    it("leaves a burst message received after the trigger for the human", async () => {
      // Message A triggered the handoff (handoff_at = A.received_at); message B
      // arrived a moment later and was queued behind A's lock.
      const { deps, responder, evolutionApi } = build({
        store: {
          inbound: {
            messageId: "msg-b",
            conversationStatus: "awaiting_human",
            handoffAt: "2026-10-14T12:00:00.000Z",
            receivedAt: "2026-10-14T12:00:00.400Z",
          },
        },
      });

      await expect(respondToInboundMessage(deps, { ...JOB, messageId: "msg-b" })).resolves.toEqual({
        status: "skipped",
        reason: "awaiting-human",
      });
      expect(responder.generate).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });
  });

  describe("CRM identification", () => {
    it("links a phone match once and passes the name to the responder", async () => {
      const { deps, store, responder, customerDirectory } = build({ phoneMatch: { id: "crm-1", name: "Ana Souza" } });

      await respondToInboundMessage(deps, JOB);

      expect(customerDirectory.findByPhone).toHaveBeenCalledWith("5511999998888");
      expect(store.linkCustomer).toHaveBeenCalledWith("conv-1", "crm-1", "phone");
      expect(responder.generate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: { status: "registered", name: "Ana Souza" } }),
      );
    });

    it("uses the stored link instead of searching by phone again", async () => {
      const { deps, store, responder, customerDirectory } = build({
        store: { inbound: { crmClientId: "crm-1", crmLinkVia: "phone" } },
        byId: { id: "crm-1", name: "Ana Souza" },
      });

      await respondToInboundMessage(deps, JOB);

      expect(customerDirectory.findByPhone).not.toHaveBeenCalled();
      expect(customerDirectory.findById).toHaveBeenCalledWith("crm-1");
      expect(store.linkCustomer).not.toHaveBeenCalled();
      expect(responder.generate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: { status: "registered", name: "Ana Souza" } }),
      );
    });

    it("never exposes the stored name on a CPF link", async () => {
      const { deps, responder, customerDirectory } = build({
        store: { inbound: { crmClientId: "crm-1", crmLinkVia: "cpf" } },
        byId: { id: "crm-1", name: "Ana Souza" },
      });

      await respondToInboundMessage(deps, JOB);

      expect(customerDirectory.findById).not.toHaveBeenCalled();
      expect(responder.generate).toHaveBeenCalledWith(expect.objectContaining({ customer: { status: "registered" } }));
    });

    it("treats a linked client deleted from the CRM as unregistered", async () => {
      const { deps, responder } = build({
        store: { inbound: { crmClientId: "crm-gone", crmLinkVia: "created" } },
        byId: null,
      });

      await respondToInboundMessage(deps, JOB);

      expect(responder.generate).toHaveBeenCalledWith(expect.objectContaining({ customer: { status: "unregistered" } }));
    });

    it("persists a link the responder made before sending", async () => {
      const { deps, store, evolutionApi } = build({
        result: { kind: "reply", text: "Cadastro feito!", linkedCustomer: { crmClientId: "crm-new", via: "created" } },
      });

      await respondToInboundMessage(deps, JOB);

      expect(store.linkCustomer).toHaveBeenCalledWith("conv-1", "crm-new", "created");
      expect(store.linkCustomer.mock.invocationCallOrder[0]).toBeLessThan(evolutionApi.sendText.mock.invocationCallOrder[0]);
    });
  });

  describe("lost lock", () => {
    it("aborts before sending a reply", async () => {
      const { deps, evolutionApi, release } = build({ lockLost: true });

      await expect(respondToInboundMessage(deps, JOB)).rejects.toBeInstanceOf(LockLostError);
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("aborts before persisting a handoff", async () => {
      const { deps, store, evolutionApi } = build({ lockLost: true, result: { kind: "handoff", summary: "x" } });

      await expect(respondToInboundMessage(deps, JOB)).rejects.toBeInstanceOf(LockLostError);
      expect(store.markAwaitingHuman).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });
  });
});
