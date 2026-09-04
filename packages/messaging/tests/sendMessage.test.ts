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
});
