import { describe, expect, it } from "vitest";
import { ingestInboundMessage } from "../src/ingestInboundMessage";
import type { InboundMessageEvent } from "../src/events";
import { createSupabaseMock } from "./support/supabaseMock";

const event: InboundMessageEvent = {
  type: "messages.upsert",
  instanceName: "acme",
  messageId: "MSG1",
  fromMe: false,
  contactPhone: "5511999998888",
  pushName: "Alice",
  text: "hello",
  timestamp: 1719000000,
};

const deps = (supabase: unknown) => ({ supabase, evolutionApi: {} } as never);

describe("ingestInboundMessage", () => {
  it("returns null when the instance is unknown", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: null, error: null }),
    });
    expect(await ingestInboundMessage(deps(supabase), event)).toBeNull();
  });

  it("returns null when the event has no text", async () => {
    const supabase = createSupabaseMock({ instances: () => ({ data: { id: "inst-1" }, error: null }) });
    expect(await ingestInboundMessage(deps(supabase), { ...event, text: null })).toBeNull();
  });

  it("persists a new message and returns its ids", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: { id: "inst-1" }, error: null }),
      conversations: (calls) =>
        calls.some((c) => c.op === "upsert")
          ? { data: null, error: null }
          : { data: { id: "conv-1" }, error: null },
      messages: () => ({ data: [{ id: "msg-1" }], error: null }),
    });

    const result = await ingestInboundMessage(deps(supabase), event);

    expect(result).toEqual({ messageId: "msg-1", conversationId: "conv-1", instanceId: "inst-1" });
  });

  it("returns the stored ids when the message already exists, so a lost enqueue can be redone (I2)", async () => {
    const lookups: unknown[][] = [];
    const supabase = createSupabaseMock({
      instances: () => ({ data: { id: "inst-1" }, error: null }),
      conversations: (calls) =>
        calls.some((c) => c.op === "upsert") ? { data: null, error: null } : { data: { id: "conv-1" }, error: null },
      messages: (calls) => {
        if (calls.some((c) => c.op === "upsert")) return { data: [], error: null };
        lookups.push(calls.filter((c) => c.op === "eq").map((c) => c.args));
        return { data: { id: "msg-old", conversation_id: "conv-1" }, error: null };
      },
    });

    expect(await ingestInboundMessage(deps(supabase), event)).toEqual({
      messageId: "msg-old",
      conversationId: "conv-1",
      instanceId: "inst-1",
    });
    // Scoped to the conversation (M6): the same WhatsApp id can exist in
    // another conversation, e.g. our own outbound from another number.
    expect(lookups).toEqual([[["conversation_id", "conv-1"], ["evolution_message_id", "MSG1"]]]);
  });

  it("returns null when the duplicate cannot be found any more", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: { id: "inst-1" }, error: null }),
      conversations: (calls) =>
        calls.some((c) => c.op === "upsert") ? { data: null, error: null } : { data: { id: "conv-1" }, error: null },
      messages: (calls) => (calls.some((c) => c.op === "upsert") ? { data: [], error: null } : { data: null, error: null }),
    });

    expect(await ingestInboundMessage(deps(supabase), event)).toBeNull();
  });

  it("throws when Supabase returns an error", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: null, error: { message: "db down" } }),
    });
    await expect(ingestInboundMessage(deps(supabase), event)).rejects.toThrow("db down");
  });
});

describe("ingestInboundMessage keeps last_message_at in step (M8)", () => {
  function supabaseWith(messages: (calls: { op: string; args: unknown[] }[]) => { data: unknown; error: unknown }, updateError: unknown = null) {
    const updates: unknown[] = [];
    const supabase = createSupabaseMock({
      instances: () => ({ data: { id: "inst-1" }, error: null }),
      conversations: (calls) => {
        if (calls.some((c) => c.op === "update")) {
          updates.push(calls[0].args[0]);
          return { data: null, error: updateError };
        }
        return calls.some((c) => c.op === "upsert") ? { data: null, error: null } : { data: { id: "conv-1" }, error: null };
      },
      messages,
    });
    return { supabase, updates };
  }

  it("fails when last_message_at cannot be written, so the webhook is redelivered", async () => {
    const { supabase } = supabaseWith(() => ({ data: [{ id: "msg-1" }], error: null }), { message: "db down" });
    await expect(ingestInboundMessage(deps(supabase), event)).rejects.toThrow("db down");
  });

  it("writes last_message_at on a redelivery too, repairing a write lost the first time", async () => {
    const { supabase, updates } = supabaseWith((calls) =>
      calls.some((c) => c.op === "upsert") ? { data: [], error: null } : { data: { id: "msg-old", conversation_id: "conv-1" }, error: null },
    );

    await ingestInboundMessage(deps(supabase), event);

    expect(updates).toEqual([{ last_message_at: expect.any(String) }]);
  });
});

describe("ingestInboundMessage dedupes per conversation (M6)", () => {
  it("treats a message as duplicate only within its own conversation", async () => {
    let upsertOptions: unknown;
    const supabase = createSupabaseMock({
      instances: () => ({ data: { id: "inst-1" }, error: null }),
      conversations: (calls) =>
        calls.some((c) => c.op === "upsert") ? { data: null, error: null } : { data: { id: "conv-1" }, error: null },
      messages: (calls) => {
        const upsert = calls.find((c) => c.op === "upsert");
        if (upsert) upsertOptions = upsert.args[1];
        return { data: [{ id: "msg-1" }], error: null };
      },
    });

    await ingestInboundMessage(deps(supabase), event);

    expect(upsertOptions).toEqual({ onConflict: "conversation_id,evolution_message_id", ignoreDuplicates: true });
  });
});
