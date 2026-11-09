import type { MessagingDeps } from "./deps";
import type { HistoryMessage } from "./responder";
import { assertNoError } from "./internal/supabaseError";
import { laterTimestamp } from "./internal/timestamps";

export const DEFAULT_HISTORY_LIMIT = 30;

interface MessageRow {
  direction: "in" | "out";
  content: string;
  created_at: string;
  received_at: string;
}

export interface HistoryWindow {
  messages: HistoryMessage[];
  /**
   * The latest received_at (database clock) among the inbound rows loaded;
   * null when the window holds no inbound. A reply generated from this window
   * answers every inbound received up to it.
   */
  seenThrough: string | null;
}

/**
 * The most recent `limit` messages of a conversation, returned oldest-first.
 * The query sorts newest-first so the limit keeps the *latest* messages; the
 * array is reversed before returning.
 */
export async function loadHistoryWindow(
  deps: Pick<MessagingDeps, "supabase">,
  conversationId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<HistoryWindow> {
  const result = await deps.supabase
    .from("messages")
    .select("direction, content, created_at, received_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  assertNoError(result.error);

  const rows = (result.data as MessageRow[] | null) ?? [];

  let seenThrough: string | null = null;
  for (const row of rows) {
    if (row.direction === "in") seenThrough = laterTimestamp(seenThrough, row.received_at);
  }

  const messages = rows
    .slice()
    .reverse()
    .map((row) => ({
      role: row.direction === "in" ? ("user" as const) : ("assistant" as const),
      content: row.content,
      createdAt: row.created_at,
    }));

  return { messages, seenThrough };
}

/** loadHistoryWindow without the watermark. */
export async function loadConversationHistory(
  deps: Pick<MessagingDeps, "supabase">,
  conversationId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<HistoryMessage[]> {
  return (await loadHistoryWindow(deps, conversationId, limit)).messages;
}

/** Silence after which a conversation starts over for the model (the CRM keeps the facts). */
export const DEFAULT_SESSION_GAP_MS = 12 * 60 * 60 * 1000;

/**
 * The messages since the last silence of `gapMs` or more, counting the gap up
 * to `nowIso` (the message being answered). Older talk is left out so it
 * cannot mislead the model; what matters is in the CRM snapshot. A timestamp
 * that cannot be read never counts as a gap.
 */
export function currentSession(messages: HistoryMessage[], nowIso: string, gapMs: number = DEFAULT_SESSION_GAP_MS): HistoryMessage[] {
  let later = Date.parse(nowIso);
  for (let i = messages.length - 1; i >= 0; i--) {
    const at = Date.parse(messages[i].createdAt);
    if (Number.isFinite(at) && Number.isFinite(later) && later - at >= gapMs) return messages.slice(i + 1);
    if (Number.isFinite(at)) later = at;
  }
  return messages;
}
