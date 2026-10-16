import { describe, expect, it, vi } from "vitest";
import { handOffAfterFailure, respondToInboundMessage } from "../src/respondToInboundMessage";
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
  const inserts: Record<string, unknown>[] = [];
  const supabase = createSupabaseMock({
    conversations: () => ({
      data: options.conversationGone
        ? null
        : { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } },
      error: null,
    }),
    messages: (calls) => {
      const insert = calls.find((c) => c.op === "insert");
      if (insert) inserts.push(insert.args[0] as Record<string, unknown>);
      return {
        data: { id: "msg-out", conversation_id: "conv-1", direction: "out", content: "x", created_at: "2026-10-14T12:00:05Z" },
        error: null,
      };
    },
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
  return { deps, store, responder, release, evolutionApi, customerDirectory, inserts };
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
    expect(store.isAnswered).toHaveBeenCalledWith("conv-1", INBOUND.receivedAt);
    expect(responder.generate).not.toHaveBeenCalled();
  });

  describe("reply watermark", () => {
    // M1 arrived at 12:00:00 and its job loaded history before M2 (12:00:01)
    // existed; reply R1 was written after M2 arrived but only covers M1.
    const M1 = { role: "user" as const, content: "oi", createdAt: "2026-10-14T12:00:00Z" };
    const R1 = { role: "assistant" as const, content: "Olá!", createdAt: "2026-10-14T12:00:04Z" };
    const M2 = { role: "user" as const, content: "qual o horário?", createdAt: "2026-10-14T12:00:01Z" };

    it("a message received after the history load is still answered", async () => {
      const { deps, responder, evolutionApi, inserts } = build({
        result: { kind: "reply", text: "Das 9h às 18h." },
        store: {
          inbound: { messageId: "msg-2", content: M2.content, createdAt: M2.createdAt, receivedAt: "2026-10-14T12:00:01.000Z" },
          outboundWatermarks: ["2026-10-14T12:00:00.000Z"],
          history: [M1, M2, R1],
          seenThrough: "2026-10-14T12:00:01.000Z",
        },
      });

      await expect(respondToInboundMessage(deps, { ...JOB, messageId: "msg-2" })).resolves.toEqual({
        status: "sent",
        messageId: "msg-out",
      });
      expect(responder.generate).toHaveBeenCalledOnce();
      expect(evolutionApi.sendText).toHaveBeenCalledWith("acme", "5511999998888", "Das 9h às 18h.");
      expect(inserts).toEqual([expect.objectContaining({ answers_through: "2026-10-14T12:00:01.000Z" })]);
    });

    it("a message the previous reply already covered is skipped", async () => {
      // R1's job saw M2 in its history: answers_through = M2.received_at.
      const { deps, responder, evolutionApi } = build({
        store: {
          inbound: { messageId: "msg-2", receivedAt: "2026-10-14T12:00:01.000Z" },
          outboundWatermarks: ["2026-10-14T12:00:01.000Z"],
        },
      });

      await expect(respondToInboundMessage(deps, { ...JOB, messageId: "msg-2" })).resolves.toEqual({
        status: "skipped",
        reason: "already-answered",
      });
      expect(responder.generate).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });

    it("covers later inbound the history already showed the model", async () => {
      const { deps, inserts } = build({ store: { seenThrough: "2026-10-14T12:00:03.000Z" } });

      await respondToInboundMessage(deps, JOB);

      expect(inserts).toEqual([expect.objectContaining({ answers_through: "2026-10-14T12:00:03.000Z" })]);
    });

    it("covers at least the message being answered when it fell out of the history window", async () => {
      const { deps, inserts } = build({ store: { history: [], seenThrough: null } });

      await respondToInboundMessage(deps, JOB);

      expect(inserts).toEqual([expect.objectContaining({ answers_through: INBOUND.receivedAt })]);
    });
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

    it("stamps the handoff notice with the reply watermark", async () => {
      const { deps, inserts } = build({
        result: { kind: "handoff", summary: "x" },
        store: { seenThrough: "2026-10-14T12:00:03.000Z" },
      });

      await respondToInboundMessage(deps, JOB);

      expect(inserts).toEqual([expect.objectContaining({ answers_through: "2026-10-14T12:00:03.000Z" })]);
    });

    it("compares with the handoff time to the microsecond (M11)", async () => {
      // Same millisecond, 100 µs later: received after the handoff, so the human owns it.
      const { deps, evolutionApi } = build({
        store: {
          inbound: {
            conversationStatus: "awaiting_human",
            handoffAt: "2026-10-14T12:00:00.000400+00:00",
            receivedAt: "2026-10-14T12:00:00.000500+00:00",
          },
        },
      });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "awaiting-human" });
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
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

    it("stamps the pending notice with the triggering message's receipt time", async () => {
      const { deps, store, inserts } = build({
        store: { inbound: { conversationStatus: "awaiting_human", handoffAt: INBOUND.receivedAt } },
      });

      await respondToInboundMessage(deps, JOB);

      expect(store.isAnswered).toHaveBeenCalledWith("conv-1", INBOUND.receivedAt);
      expect(store.loadHistory).not.toHaveBeenCalled();
      expect(inserts).toEqual([expect.objectContaining({ answers_through: INBOUND.receivedAt })]);
    });

    it("stamps a notice sent by an earlier burst message with the handoff time", async () => {
      // Message A (earlier) and trigger T (handoff_at) were both in flight when
      // T's send failed. A's job sends the notice; it must cover T too, or T's
      // retry would send a second notice.
      const { deps, store, inserts } = build({
        store: {
          inbound: {
            messageId: "msg-a",
            conversationStatus: "awaiting_human",
            receivedAt: "2026-10-14T11:59:59.500Z",
            handoffAt: "2026-10-14T12:00:00.000Z",
          },
        },
      });

      await respondToInboundMessage(deps, { ...JOB, messageId: "msg-a" });

      expect(store.isAnswered).toHaveBeenCalledWith("conv-1", "2026-10-14T11:59:59.500Z");
      expect(inserts).toEqual([expect.objectContaining({ answers_through: "2026-10-14T12:00:00.000Z" })]);
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

describe("handOffAfterFailure", () => {
  it("hands the conversation to a human and tells the customer, so a dead bot is never silent", async () => {
    const { deps, store, responder, evolutionApi, inserts, release } = build();

    await expect(handOffAfterFailure(deps, JOB, "sem crédito no provedor")).resolves.toEqual({
      status: "handoff",
      messageId: "msg-out",
    });
    expect(store.markAwaitingHuman).toHaveBeenCalledWith("conv-1", {
      summary: "Bot indisponível: sem crédito no provedor",
      handoffAt: INBOUND.receivedAt,
    });
    expect(evolutionApi.sendText).toHaveBeenCalledWith("acme", "5511999998888", AGENT.handoffMessage);
    expect(inserts).toEqual([expect.objectContaining({ answers_through: INBOUND.receivedAt })]);
    expect(responder.generate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["the message was answered meanwhile", { answered: true }, "already-answered"],
    ["the conversation is already with a human", { inbound: { conversationStatus: "awaiting_human" as const } }, "awaiting-human"],
    ["the bot was switched off", { agent: null }, "no-active-agent"],
    ["the message is gone", { inbound: null }, "message-not-found"],
  ])("does nothing when %s", async (_label, store, reason) => {
    const { deps, evolutionApi, store: fake } = build({ store });

    await expect(handOffAfterFailure(deps, JOB, "x")).resolves.toEqual({ status: "skipped", reason });
    expect(fake.markAwaitingHuman).not.toHaveBeenCalled();
    expect(evolutionApi.sendText).not.toHaveBeenCalled();
  });

  it("leaves the conversation to whichever job holds its lock", async () => {
    const { deps, evolutionApi } = build({ lockBusy: true });

    await expect(handOffAfterFailure(deps, JOB, "x")).resolves.toEqual({ status: "skipped", reason: "busy" });
    expect(evolutionApi.sendText).not.toHaveBeenCalled();
  });
});
