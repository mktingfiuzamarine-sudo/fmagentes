import { describe, expect, it } from "vitest";
import { loadConversationHistory, loadHistoryWindow } from "../src/conversationHistory";
import { createSupabaseMock } from "./support/supabaseMock";

function deps(rows: unknown) {
  return { supabase: createSupabaseMock({ messages: () => ({ data: rows, error: null }) }) } as never;
}

describe("loadConversationHistory", () => {
  it("returns messages oldest-first with direction mapped to role", async () => {
    // The query orders newest-first; the function reverses it.
    const rows = [
      { direction: "out", content: "b", created_at: "2026-09-17T10:01:00Z" },
      { direction: "in", content: "a", created_at: "2026-09-17T10:00:00Z" },
    ];

    await expect(loadConversationHistory(deps(rows), "conv-1")).resolves.toEqual([
      { role: "user", content: "a", createdAt: "2026-09-17T10:00:00Z" },
      { role: "assistant", content: "b", createdAt: "2026-09-17T10:01:00Z" },
    ]);
  });

  it("returns an empty array when the conversation has no messages", async () => {
    await expect(loadConversationHistory(deps(null), "conv-1")).resolves.toEqual([]);
  });

  it("asks the database for the requested limit", async () => {
    // Restructured from the brief: instead of monkeypatching `supabase.from`
    // (which would need a return type incompatible with the mock's chain and
    // fails `tsc --noEmit`), the handler inspects the recorded call chain for
    // the `limit` call and its argument.
    const recorded: unknown[][] = [];
    const supabase = createSupabaseMock({
      messages: (calls) => {
        const limitCall = calls.find((c) => c.op === "limit");
        if (limitCall) recorded.push(limitCall.args);
        return { data: [], error: null };
      },
    });

    await loadConversationHistory({ supabase } as never, "conv-1", 5);

    expect(recorded).toEqual([[5]]);
  });

  it("throws when Supabase returns an error", async () => {
    const supabase = createSupabaseMock({
      messages: () => ({ data: null, error: { message: "boom" } }),
    });
    await expect(loadConversationHistory({ supabase } as never, "conv-1")).rejects.toThrow("boom");
  });

  it("defaults to the 30 most recent messages", async () => {
    const recorded: unknown[][] = [];
    const supabase = createSupabaseMock({
      messages: (calls) => {
        const limitCall = calls.find((c) => c.op === "limit");
        if (limitCall) recorded.push(limitCall.args);
        return { data: [], error: null };
      },
    });

    await loadConversationHistory({ supabase } as never, "conv-1");

    expect(recorded).toEqual([[30]]);
  });
});

describe("loadHistoryWindow", () => {
  it("reports the latest inbound received_at it loaded as seenThrough", async () => {
    const rows = [
      { direction: "in", content: "c", created_at: "2026-09-17T10:00:01Z", received_at: "2026-09-17T10:00:05.000002+00:00" },
      // Outbound rows never count: only what the customer said was seen.
      { direction: "out", content: "b", created_at: "2026-09-17T10:01:00Z", received_at: "2026-09-17T10:09:00+00:00" },
      { direction: "in", content: "a", created_at: "2026-09-17T10:00:00Z", received_at: "2026-09-17T10:00:05.000001+00:00" },
    ];

    const window = await loadHistoryWindow(deps(rows), "conv-1", 30);

    expect(window.seenThrough).toBe("2026-09-17T10:00:05.000002+00:00");
    expect(window.messages).toEqual([
      { role: "user", content: "a", createdAt: "2026-09-17T10:00:00Z" },
      { role: "assistant", content: "b", createdAt: "2026-09-17T10:01:00Z" },
      { role: "user", content: "c", createdAt: "2026-09-17T10:00:01Z" },
    ]);
  });

  it("selects received_at and reports null when no inbound was loaded", async () => {
    let selected: unknown[] = [];
    const supabase = createSupabaseMock({
      messages: (calls) => {
        selected = calls.find((c) => c.op === "select")?.args ?? [];
        return { data: [], error: null };
      },
    });

    await expect(loadHistoryWindow({ supabase } as never, "conv-1", 30)).resolves.toEqual({
      messages: [],
      seenThrough: null,
    });
    expect(String(selected[0])).toContain("received_at");
  });
});
