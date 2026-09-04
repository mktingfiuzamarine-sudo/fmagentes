import type { MessagingDeps } from "./deps";
import { assertNoError } from "./internal/supabaseError";

export interface SentMessage {
  id: string;
  conversationId: string;
  direction: "out";
  content: string;
  createdAt: string;
}

export class ConversationNotFoundError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = "ConversationNotFoundError";
  }
}

export async function sendMessage(
  deps: MessagingDeps,
  input: { conversationId: string; text: string },
): Promise<SentMessage> {
  const lookup = await deps.supabase
    .from("conversations")
    .select("id, contact_phone, instances(evolution_instance_id)")
    .eq("id", input.conversationId)
    .maybeSingle();
  assertNoError(lookup.error);

  const conv = lookup.data as
    | { id: string; contact_phone: string; instances: { evolution_instance_id: string } | null }
    | null;
  if (!conv || !conv.instances) throw new ConversationNotFoundError(input.conversationId);

  const sent = await deps.evolutionApi.sendText(
    conv.instances.evolution_instance_id,
    conv.contact_phone,
    input.text,
  );

  const insert = await deps.supabase
    .from("messages")
    .insert({
      conversation_id: conv.id,
      direction: "out",
      role: "assistant",
      content: input.text,
      evolution_message_id: sent.messageId,
    })
    .select("id, conversation_id, direction, content, created_at")
    .single();
  assertNoError(insert.error);

  const row = insert.data as { id: string; conversation_id: string; direction: "out"; content: string; created_at: string };

  await deps.supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conv.id);

  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: "out",
    content: row.content,
    createdAt: row.created_at,
  };
}
