import { describe, expect, it } from "vitest";
import { loadConversationHistory } from "../src/conversationHistory";
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
});
