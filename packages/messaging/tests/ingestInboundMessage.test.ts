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

  it("returns null when the message already exists (idempotent upsert no-op)", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: { id: "inst-1" }, error: null }),
      conversations: (calls) =>
        calls.some((c) => c.op === "upsert") ? { data: null, error: null } : { data: { id: "conv-1" }, error: null },
      messages: () => ({ data: [], error: null }),
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
