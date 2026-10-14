import { describe, expect, it } from "vitest";
import { createSupabaseRespondStore } from "../src/respondStore";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const INBOUND_ROW = {
  id: "msg-in",
  conversation_id: "conv-1",
  content: "ola",
  created_at: "2025-01-01T00:00:00Z",
  received_at: "2026-10-14T12:00:00.123456+00:00",
  conversations: {
    id: "conv-1",
    instance_id: "inst-1",
    agent_id: "agent-1",
    contact_phone: "5511999998888",
    status: "awaiting_human",
    handoff_at: "2026-10-14T12:00:00.123456+00:00",
    crm_client_id: "crm-1",
    crm_link_via: "phone",
  },
};

function storeWith(handlers: Record<string, (calls: TableCall) => { data: unknown; error: unknown }>) {
  return createSupabaseRespondStore(createSupabaseMock(handlers) as never);
}

describe("createSupabaseRespondStore", () => {
  it("loads the inbound message with its conversation state", async () => {
    const store = storeWith({ messages: () => ({ data: INBOUND_ROW, error: null }) });

    await expect(store.loadInbound("msg-in")).resolves.toEqual({
      messageId: "msg-in",
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: "agent-1",
      contactPhone: "5511999998888",
      content: "ola",
      createdAt: "2025-01-01T00:00:00Z",
      receivedAt: "2026-10-14T12:00:00.123456+00:00",
      conversationStatus: "awaiting_human",
      handoffAt: "2026-10-14T12:00:00.123456+00:00",
      crmClientId: "crm-1",
      crmLinkVia: "phone",
    });
  });

  it("returns null when the message or its conversation is gone", async () => {
    await expect(storeWith({ messages: () => ({ data: null, error: null }) }).loadInbound("x")).resolves.toBeNull();
    await expect(
      storeWith({ messages: () => ({ data: { ...INBOUND_ROW, conversations: null }, error: null }) }).loadInbound("x"),
    ).resolves.toBeNull();
  });

  it("checks for outbound rows created after the inbound's received_at", async () => {
    let recorded: TableCall = [];
    const store = storeWith({
      messages: (calls) => {
        recorded = calls;
        return { data: { id: "out-1" }, error: null };
      },
    });

    await expect(store.hasOutboundAfter("conv-1", "2026-10-14T12:00:00Z")).resolves.toBe(true);
    expect(recorded).toEqual(
      expect.arrayContaining([
        { op: "eq", args: ["conversation_id", "conv-1"] },
        { op: "eq", args: ["direction", "out"] },
        { op: "gt", args: ["created_at", "2026-10-14T12:00:00Z"] },
      ]),
    );
  });

  it("reports no outbound when none exists", async () => {
    const store = storeWith({ messages: () => ({ data: null, error: null }) });
    await expect(store.hasOutboundAfter("conv-1", "2026-10-14T12:00:00Z")).resolves.toBe(false);
  });

  it("writes the CRM link onto the conversation", async () => {
    let recorded: TableCall = [];
    const store = storeWith({
      conversations: (calls) => {
        recorded = calls;
        return { data: null, error: null };
      },
    });

    await store.linkCustomer("conv-1", "crm-1", "cpf");

    expect(recorded).toEqual([
      { op: "update", args: [{ crm_client_id: "crm-1", crm_link_via: "cpf" }] },
      { op: "eq", args: ["id", "conv-1"] },
    ]);
  });

  it("marks the conversation awaiting a human", async () => {
    let recorded: TableCall = [];
    const store = storeWith({
      conversations: (calls) => {
        recorded = calls;
        return { data: null, error: null };
      },
    });

    await store.markAwaitingHuman("conv-1", { summary: "Quer orçamento", handoffAt: "2026-10-14T12:00:00Z" });

    expect(recorded).toEqual([
      {
        op: "update",
        args: [{ status: "awaiting_human", handoff_summary: "Quer orçamento", handoff_at: "2026-10-14T12:00:00Z" }],
      },
      { op: "eq", args: ["id", "conv-1"] },
    ]);
  });

  it("throws when a write fails", async () => {
    const store = storeWith({ conversations: () => ({ data: null, error: { message: "boom" } }) });
    await expect(store.linkCustomer("conv-1", "crm-1", "phone")).rejects.toThrow("boom");
  });
});
