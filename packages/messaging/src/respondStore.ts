import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentConfig } from "./responder";
import { loadHistoryWindow, type HistoryWindow } from "./conversationHistory";
import { resolveAgentForConversation } from "./resolveAgent";
import { assertNoError } from "./internal/supabaseError";

export type CrmLinkVia = "phone" | "cpf" | "created";
export type ConversationStatus = "open" | "awaiting_human";

export interface InboundContext {
  messageId: string;
  conversationId: string;
  instanceId: string;
  agentId: string | null;
  contactPhone: string;
  content: string;
  /** Device timestamp; used only for history ordering. */
  createdAt: string;
  /** Database clock; used for every retry/handoff comparison. */
  receivedAt: string;
  conversationStatus: ConversationStatus;
  handoffAt: string | null;
  crmClientId: string | null;
  crmLinkVia: CrmLinkVia | null;
}

/** Every database read/write respondToInboundMessage needs, except sending. */
export interface RespondStore {
  loadInbound(messageId: string): Promise<InboundContext | null>;
  resolveAgent(input: { conversationId: string; instanceId: string; agentId: string | null }): Promise<AgentConfig | null>;
  /**
   * Some outbound row's answers_through covers `receivedAt` (both on the
   * database clock). An outbound merely created later does not count: its
   * responder may have loaded history before this message arrived.
   */
  isAnswered(conversationId: string, receivedAt: string): Promise<boolean>;
  loadHistory(conversationId: string, limit: number): Promise<HistoryWindow>;
  linkCustomer(conversationId: string, crmClientId: string, via: CrmLinkVia): Promise<void>;
  markAwaitingHuman(conversationId: string, handoff: { summary: string; handoffAt: string }): Promise<void>;
}

const INBOUND_COLUMNS =
  "id, conversation_id, content, created_at, received_at, " +
  "conversations(id, instance_id, agent_id, contact_phone, status, handoff_at, crm_client_id, crm_link_via)";

interface InboundRow {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
  received_at: string;
  conversations: {
    id: string;
    instance_id: string;
    agent_id: string | null;
    contact_phone: string;
    status: ConversationStatus;
    handoff_at: string | null;
    crm_client_id: string | null;
    crm_link_via: CrmLinkVia | null;
  } | null;
}

export function createSupabaseRespondStore(supabase: SupabaseClient): RespondStore {
  const deps = { supabase };

  return {
    async loadInbound(messageId) {
      const lookup = await supabase.from("messages").select(INBOUND_COLUMNS).eq("id", messageId).maybeSingle();
      assertNoError(lookup.error);

      const row = lookup.data as InboundRow | null;
      if (!row || !row.conversations) return null;
      const conversation = row.conversations;

      return {
        messageId: row.id,
        conversationId: conversation.id,
        instanceId: conversation.instance_id,
        agentId: conversation.agent_id,
        contactPhone: conversation.contact_phone,
        content: row.content,
        createdAt: row.created_at,
        receivedAt: row.received_at,
        conversationStatus: conversation.status,
        handoffAt: conversation.handoff_at,
        crmClientId: conversation.crm_client_id,
        crmLinkVia: conversation.crm_link_via,
      };
    },

    resolveAgent: (input) => resolveAgentForConversation(deps, input),

    async isAnswered(conversationId, receivedAt) {
      const answered = await supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("direction", "out")
        .gte("answers_through", receivedAt)
        .limit(1)
        .maybeSingle();
      assertNoError(answered.error);
      return answered.data !== null;
    },

    loadHistory: (conversationId, limit) => loadHistoryWindow(deps, conversationId, limit),

    async linkCustomer(conversationId, crmClientId, via) {
      const result = await supabase
        .from("conversations")
        .update({ crm_client_id: crmClientId, crm_link_via: via })
        .eq("id", conversationId);
      assertNoError(result.error);
    },

    async markAwaitingHuman(conversationId, handoff) {
      const result = await supabase
        .from("conversations")
        .update({ status: "awaiting_human", handoff_summary: handoff.summary, handoff_at: handoff.handoffAt })
        .eq("id", conversationId);
      assertNoError(result.error);
    },
  };
}
