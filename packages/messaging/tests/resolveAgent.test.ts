import { describe, expect, it } from "vitest";
import { resolveAgentForConversation } from "../src/resolveAgent";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const AGENT_ROW = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-opus-5",
  system_prompt: "Seja breve.",
};

const EXPECTED = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-opus-5",
  systemPrompt: "Seja breve.",
};

function deps(agentRow: unknown, onConversationUpdate?: (calls: TableCall) => void) {
  const supabase = createSupabaseMock({
    agents: () => ({ data: agentRow, error: null }),
    conversations: (calls) => {
      onConversationUpdate?.(calls);
      return { data: null, error: null };
    },
  });
  return { supabase } as never;
}

describe("resolveAgentForConversation", () => {
  it("returns the pinned agent without touching the conversation", async () => {
    let updated = false;
    const d = deps(AGENT_ROW, (calls) => {
      if (calls.some((c) => c.op === "update")) updated = true;
    });

    const agent = await resolveAgentForConversation(d, {
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: "agent-1",
    });

    expect(agent).toEqual(EXPECTED);
    expect(updated).toBe(false);
  });

  it("returns null when the pinned agent is no longer active", async () => {
    const agent = await resolveAgentForConversation(deps(null), {
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: "agent-gone",
    });

    expect(agent).toBeNull();
  });

  it("picks the instance's active agent and pins it to the conversation", async () => {
    const updates: TableCall = [];
    const d = deps(AGENT_ROW, (calls) => {
      updates.length = 0;
      updates.push(...calls);
    });

    const agent = await resolveAgentForConversation(d, {
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: null,
    });

    expect(agent).toEqual(EXPECTED);
    expect(updates.some((c) => c.op === "update" && JSON.stringify(c.args).includes("agent-1"))).toBe(true);
  });

  it("returns null when the instance has no active agent", async () => {
    const agent = await resolveAgentForConversation(deps(null), {
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: null,
    });

    expect(agent).toBeNull();
  });

  it("throws when Supabase returns an error", async () => {
    const supabase = createSupabaseMock({
      agents: () => ({ data: null, error: { message: "boom" } }),
    });
    await expect(
      resolveAgentForConversation({ supabase } as never, {
        conversationId: "conv-1",
        instanceId: "inst-1",
        agentId: null,
      }),
    ).rejects.toThrow("boom");
  });
});
