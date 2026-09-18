import type { MessagingDeps } from "./deps";
import type { HistoryMessage } from "./responder";
import { assertNoError } from "./internal/supabaseError";

export const DEFAULT_HISTORY_LIMIT = 20;

interface MessageRow {
  direction: "in" | "out";
  content: string;
  created_at: string;
}

/**
 * The most recent `limit` messages of a conversation, returned oldest-first.
 * The query sorts newest-first so the limit keeps the *latest* messages; the
 * array is reversed before returning.
 */
export async function loadConversationHistory(
  deps: MessagingDeps,
  conversationId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<HistoryMessage[]> {
  const result = await deps.supabase
    .from("messages")
    .select("direction, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  assertNoError(result.error);

  const rows = (result.data as MessageRow[] | null) ?? [];

  return rows
    .slice()
    .reverse()
    .map((row) => ({
      role: row.direction === "in" ? ("user" as const) : ("assistant" as const),
      content: row.content,
      createdAt: row.created_at,
    }));
}
