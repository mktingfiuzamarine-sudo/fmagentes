import { describe, expect, it, vi } from "vitest";
import { sendMessage, ConversationNotFoundError } from "../src/sendMessage";
import { createSupabaseMock } from "./support/supabaseMock";

function deps(overrides: { conversation?: unknown; sendText?: unknown; insertedRow?: unknown } = {}) {
  const supabase = createSupabaseMock({
    conversations: (calls) =>
      calls.some((c) => c.op === "update")
        ? { data: null, error: null }
        : { data: overrides.conversation === undefined
            ? { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } }
            : overrides.conversation,
            error: null },
    messages: () => ({ data: overrides.insertedRow ?? { id: "msg-1", conversation_id: "conv-1", direction: "out", content: "hi", created_at: "2026-09-02T00:00:00Z" }, error: null }),
  });
  const evolutionApi = {
    sendText: overrides.sendText ?? vi.fn().mockResolvedValue({ messageId: "EVO1" }),
  };
  return { supabase, evolutionApi } as never;
}

describe("sendMessage", () => {
  it("sends via Evolution then persists the outbound row and bumps last_message_at", async () => {
    const d = deps();
    const result = await sendMessage(d, { conversationId: "conv-1", text: "hi" });

    expect(result).toEqual({
      id: "msg-1",
      conversationId: "conv-1",
      direction: "out",
      content: "hi",
      createdAt: "2026-09-02T00:00:00Z",
    });
    expect((d as never as { evolutionApi: { sendText: ReturnType<typeof vi.fn> } }).evolutionApi.sendText)
      .toHaveBeenCalledWith("acme", "5511999998888", "hi");
  });

  it("throws ConversationNotFoundError when the conversation is missing", async () => {
    await expect(sendMessage(deps({ conversation: null }), { conversationId: "nope", text: "hi" }))
      .rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("propagates an Evolution failure and does not persist", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("evolution 500"));
    await expect(sendMessage(deps({ sendText }), { conversationId: "conv-1", text: "hi" }))
      .rejects.toThrow("evolution 500");
  });

  it("writes answers_through on the outbound row when given", async () => {
    const inserts: unknown[] = [];
    const supabase = createSupabaseMock({
      conversations: () => ({
        data: { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } },
        error: null,
      }),
      messages: (calls) => {
        const insert = calls.find((c) => c.op === "insert");
        if (insert) inserts.push(insert.args[0]);
        return { data: { id: "msg-1", conversation_id: "conv-1", direction: "out", content: "hi", created_at: "x" }, error: null };
      },
    });
    const evolutionApi = { sendText: vi.fn().mockResolvedValue({ messageId: "EVO1" }) };

    await sendMessage({ supabase, evolutionApi } as never, {
      conversationId: "conv-1",
      text: "hi",
      answersThrough: "2026-10-14T12:00:00.123456+00:00",
    });
    await sendMessage({ supabase, evolutionApi } as never, { conversationId: "conv-1", text: "hi" });

    expect(inserts).toEqual([
      expect.objectContaining({ answers_through: "2026-10-14T12:00:00.123456+00:00" }),
      expect.not.objectContaining({ answers_through: expect.anything() }),
    ]);
  });

  it("writes sent_by on the outbound row when a human sends", async () => {
    const inserts: unknown[] = [];
    const supabase = createSupabaseMock({
      conversations: () => ({
        data: { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } },
        error: null,
      }),
      messages: (calls) => {
        const insert = calls.find((c) => c.op === "insert");
        if (insert) inserts.push(insert.args[0]);
        return { data: { id: "msg-1", conversation_id: "conv-1", direction: "out", content: "hi", created_at: "x" }, error: null };
      },
    });
    const evolutionApi = { sendText: vi.fn().mockResolvedValue({ messageId: "EVO1" }) };

    await sendMessage({ supabase, evolutionApi } as never, { conversationId: "conv-1", text: "hi", sentBy: "user-1" });

    expect(inserts).toEqual([expect.objectContaining({ sent_by: "user-1" })]);
    expect(inserts[0]).not.toHaveProperty("answers_through");
  });
});

describe("sendMessage records the reply before sending it (I6)", () => {
  const CONVERSATION = { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } };
  const ROW = { id: "msg-1", conversation_id: "conv-1", direction: "out", content: "hi", created_at: "x" };

  function recording(options: { insertError?: unknown; sendText?: ReturnType<typeof vi.fn> } = {}) {
    const events: string[] = [];
    const writes: { op: string; args: unknown[] }[] = [];
    const supabase = createSupabaseMock({
      conversations: (calls) => (calls.some((c) => c.op === "update") ? { data: null, error: null } : { data: CONVERSATION, error: null }),
      messages: (calls) => {
        const write = calls.find((c) => ["insert", "update", "delete"].includes(c.op));
        if (write) {
          events.push(`messages.${write.op}`);
          writes.push(write);
        }
        if (write?.op === "insert" && options.insertError) return { data: null, error: options.insertError };
        return { data: ROW, error: null };
      },
    });
    const sendText =
      options.sendText ??
      vi.fn(async () => {
        events.push("sendText");
        return { messageId: "EVO1" };
      });
    return { deps: { supabase, evolutionApi: { sendText } } as never, events, writes, sendText };
  }

  it("inserts the outbound row before calling Evolution, then stores Evolution's id", async () => {
    const { deps, events, writes } = recording();

    await sendMessage(deps, { conversationId: "conv-1", text: "hi", answersThrough: "2026-10-16T00:00:00Z" });

    expect(events).toEqual(["messages.insert", "sendText", "messages.update"]);
    expect(writes[0].args[0]).toEqual(expect.objectContaining({ answers_through: "2026-10-16T00:00:00Z" }));
    expect(writes[0].args[0]).not.toHaveProperty("evolution_message_id");
    expect(writes[1].args[0]).toEqual({ evolution_message_id: "EVO1" });
  });

  it("does not call Evolution when the row cannot be recorded", async () => {
    const { deps, sendText } = recording({ insertError: { message: "db down" } });

    await expect(sendMessage(deps, { conversationId: "conv-1", text: "hi" })).rejects.toThrow("db down");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("removes the recorded row when Evolution fails, so a retry can answer again", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("evolution 500"));
    const { deps, events } = recording({ sendText });

    await expect(sendMessage(deps, { conversationId: "conv-1", text: "hi" })).rejects.toThrow("evolution 500");
    expect(events).toEqual(["messages.insert", "messages.delete"]);
  });

  it("still reports the message as sent when only storing Evolution's id fails", async () => {
    const events: string[] = [];
    const supabase = createSupabaseMock({
      conversations: () => ({ data: CONVERSATION, error: null }),
      messages: (calls) => {
        if (calls.some((c) => c.op === "update")) {
          events.push("messages.update");
          return { data: null, error: { message: "db blip" } };
        }
        return { data: ROW, error: null };
      },
    });
    const evolutionApi = { sendText: vi.fn().mockResolvedValue({ messageId: "EVO1" }) };

    await expect(sendMessage({ supabase, evolutionApi } as never, { conversationId: "conv-1", text: "hi" }))
      .resolves.toEqual(expect.objectContaining({ id: "msg-1" }));
    expect(events).toEqual(["messages.update"]);
  });
});
