import type { MessagingDeps } from "./deps";
import { ConversationNotFoundError } from "./sendMessage";
import { assertNoError } from "./internal/supabaseError";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hands a conversation back to the agent and clears its handoff and
 * assignment. Idempotent: resuming an open conversation succeeds. A malformed
 * id is "not found" rather than a uuid cast error from Postgres.
 */
export async function resumeConversation(
  deps: Pick<MessagingDeps, "supabase">,
  conversationId: string,
): Promise<void> {
  if (!UUID.test(conversationId)) throw new ConversationNotFoundError(conversationId);

  const result = await deps.supabase
    .from("conversations")
    .update({ status: "open", handoff_summary: null, handoff_at: null, assigned_to: null, assigned_at: null })
    .eq("id", conversationId)
    .select("id");
  assertNoError(result.error);

  const rows = (result.data as Array<{ id: string }> | null) ?? [];
  if (rows.length === 0) throw new ConversationNotFoundError(conversationId);
}
