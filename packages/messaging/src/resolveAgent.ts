import type { MessagingDeps } from "./deps";
import type { AgentConfig } from "./responder";
import { assertNoError } from "./internal/supabaseError";

const AGENT_COLUMNS = "id, name, provider, model, system_prompt, handoff_message";

interface AgentRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  system_prompt: string;
  handoff_message: string;
}

function toConfig(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    systemPrompt: row.system_prompt,
    handoffMessage: row.handoff_message,
  };
}

/**
 * Resolves which agent answers a conversation.
 *
 * A pinned agent that has been deactivated resolves to null — the same as
 * having no agent at all — so deactivating an agent stops the bot everywhere,
 * not just on new conversations.
 */
export async function resolveAgentForConversation(
  deps: Pick<MessagingDeps, "supabase">,
  input: { conversationId: string; instanceId: string; agentId: string | null },
): Promise<AgentConfig | null> {
  if (input.agentId) {
    const pinned = await deps.supabase
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("id", input.agentId)
      .eq("is_active", true)
      .maybeSingle();
    assertNoError(pinned.error);

    const row = pinned.data as AgentRow | null;
    return row ? toConfig(row) : null;
  }

  const candidate = await deps.supabase
    .from("agents")
    .select(AGENT_COLUMNS)
    .eq("instance_id", input.instanceId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  assertNoError(candidate.error);

  const row = candidate.data as AgentRow | null;
  if (!row) return null;

  const pin = await deps.supabase
    .from("conversations")
    .update({ agent_id: row.id })
    .eq("id", input.conversationId);
  assertNoError(pin.error);

  return toConfig(row);
}
