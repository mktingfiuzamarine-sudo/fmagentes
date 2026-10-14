import { describe, expect, it } from "vitest";
import { resolveAgentForConversation } from "../src/resolveAgent";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const AGENT_ROW = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-opus-5",
  system_prompt: "Seja breve.",
  handoff_message: "Já te passo.",
};

const EXPECTED = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-opus-5",
  systemPrompt: "Seja breve.",
  handoffMessage: "Já te passo.",
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

/**
 * Builds an `agents` handler that returns different data depending on which
 * `.eq()` filter was actually chained, so tests can tell the pinned-agent
 * query (`eq("id", ...)`) apart from the instance auto-assignment query
 * (`eq("instance_id", ...)`) — a fixed closure can't discriminate branches.
 */
function agentsByLookup(byId: unknown, byInstance: unknown) {
  return (calls: TableCall) => {
    const lookedUpById = calls.some((c) => c.op === "eq" && c.args[0] === "id");
    const lookedUpByInstance = calls.some((c) => c.op === "eq" && c.args[0] === "instance_id");
    if (lookedUpById) return { data: byId, error: null };
    if (lookedUpByInstance) return { data: byInstance, error: null };
    return { data: null, error: null };
  };
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
    // byId: null (the pinned agent is inactive/gone) — byInstance: AGENT_ROW,
    // so a swapped-branch bug (routing this agentId through the instance
    // auto-assignment query instead) would surface a non-null agent here.
    const supabase = createSupabaseMock({
      agents: agentsByLookup(null, AGENT_ROW),
      conversations: () => ({ data: null, error: null }),
    });

    const agent = await resolveAgentForConversation({ supabase } as never, {
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
    // byInstance: null (no active agent for this instance) — byId: AGENT_ROW,
    // so a swapped-branch bug (routing this null agentId through the pinned
    // id lookup instead) would surface a non-null agent here.
    const supabase = createSupabaseMock({
      agents: agentsByLookup(AGENT_ROW, null),
      conversations: () => ({ data: null, error: null }),
    });

    const agent = await resolveAgentForConversation({ supabase } as never, {
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
