import type { MessagingDeps } from "./deps";
import type { InboundJobData } from "./inboundQueue";
import type { HistoryMessage } from "./responder";
import { ConversationBusyError } from "./conversationLock";
import { loadConversationHistory } from "./conversationHistory";
import { resolveAgentForConversation } from "./resolveAgent";
import { sendMessage, ConversationNotFoundError } from "./sendMessage";
import { assertNoError } from "./internal/supabaseError";

export type RespondDeps = MessagingDeps &
  Required<Pick<MessagingDeps, "responder" | "conversationLock">>;

export type RespondResult =
  | { status: "sent"; messageId: string }
  | {
      status: "skipped";
      reason: "no-active-agent" | "already-answered" | "responder-declined" | "message-not-found";
    };

interface InboundRow {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
  conversations: { id: string; instance_id: string; agent_id: string | null } | null;
}

export async function respondToInboundMessage(
  deps: RespondDeps,
  job: InboundJobData,
): Promise<RespondResult> {
  const lock = await deps.conversationLock.acquire(job.conversationId);
  if (!lock) throw new ConversationBusyError(job.conversationId);

  try {
    const lookup = await deps.supabase
      .from("messages")
      .select("id, conversation_id, content, created_at, conversations(id, instance_id, agent_id)")
      .eq("id", job.messageId)
      .maybeSingle();
    assertNoError(lookup.error);

    const inbound = lookup.data as InboundRow | null;
    if (!inbound || !inbound.conversations) {
      return { status: "skipped", reason: "message-not-found" };
    }

    const agent = await resolveAgentForConversation(deps, {
      conversationId: inbound.conversations.id,
      instanceId: inbound.conversations.instance_id,
      agentId: inbound.conversations.agent_id,
    });
    if (!agent) return { status: "skipped", reason: "no-active-agent" };

    // Retry safety: if anything outbound landed after this message, a previous
    // attempt already answered it.
    const answered = await deps.supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", inbound.conversation_id)
      .eq("direction", "out")
      .gt("created_at", inbound.created_at)
      .limit(1)
      .maybeSingle();
    assertNoError(answered.error);
    if (answered.data) return { status: "skipped", reason: "already-answered" };

    const history = await loadConversationHistory(deps, inbound.conversation_id);
    const incoming: HistoryMessage = {
      role: "user",
      content: inbound.content,
      createdAt: inbound.created_at,
    };

    const reply = await deps.responder.generate({ agent, history, incoming });
    if (reply === null) return { status: "skipped", reason: "responder-declined" };

    try {
      const sent = await sendMessage(deps, { conversationId: inbound.conversation_id, text: reply });
      return { status: "sent", messageId: sent.id };
    } catch (error) {
      // The conversation vanished mid-flight; retrying cannot fix that.
      if (error instanceof ConversationNotFoundError) {
        return { status: "skipped", reason: "message-not-found" };
      }
      throw error;
    }
  } finally {
    await lock.release();
  }
}
