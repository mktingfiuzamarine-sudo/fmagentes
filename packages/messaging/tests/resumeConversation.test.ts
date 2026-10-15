import { describe, expect, it } from "vitest";
import { resumeConversation } from "../src/resumeConversation";
import { ConversationNotFoundError } from "../src/sendMessage";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const ID = "6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b";

describe("resumeConversation", () => {
  it("reopens the conversation and clears the handoff", async () => {
    let recorded: TableCall = [];
    const supabase = createSupabaseMock({
      conversations: (calls) => {
        recorded = calls;
        return { data: [{ id: ID }], error: null };
      },
    });

    await resumeConversation({ supabase } as never, ID);

    expect(recorded).toEqual([
      { op: "update", args: [{ status: "open", handoff_summary: null, handoff_at: null, assigned_to: null, assigned_at: null }] },
      { op: "eq", args: ["id", ID] },
      { op: "select", args: ["id"] },
    ]);
  });

  it("throws ConversationNotFoundError when nothing was updated", async () => {
    const supabase = createSupabaseMock({ conversations: () => ({ data: [], error: null }) });
    await expect(resumeConversation({ supabase } as never, ID)).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("treats a malformed id as not found without querying", async () => {
    let queried = false;
    const supabase = createSupabaseMock({
      conversations: () => {
        queried = true;
        return { data: [], error: null };
      },
    });

    await expect(resumeConversation({ supabase } as never, "abc")).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(queried).toBe(false);
  });
});
