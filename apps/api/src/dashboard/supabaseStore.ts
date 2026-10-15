import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AgentInput,
  AgentRow,
  AssignOutcome,
  CrmLinkVia,
  ConversationStatus,
  DashboardStore,
  InboxRow,
  InboxView,
  InstanceWithAgents,
  MessageRow,
} from "./store";

const INBOX_COLUMNS =
  "id, instance_id, instance_name, contact_phone, status, handoff_summary, handoff_at, assigned_to, assigned_at, crm_client_id, crm_link_via, last_message_at, last_direction, last_content, last_created_at";
const AGENT_COLUMNS = "id, instance_id, name, provider, model, system_prompt, handoff_message, is_active, created_at";
const ALL_LIMIT = 100;
const HANDOFF_LIMIT = 200;

interface InboxViewRow {
  id: string;
  instance_id: string;
  instance_name: string;
  contact_phone: string;
  status: ConversationStatus;
  handoff_summary: string | null;
  handoff_at: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  crm_client_id: string | null;
  crm_link_via: CrmLinkVia | null;
  last_message_at: string | null;
  last_direction: "in" | "out" | null;
  last_content: string | null;
  last_created_at: string | null;
}

interface AgentDbRow {
  id: string;
  instance_id: string;
  name: string;
  provider: string;
  model: string;
  system_prompt: string;
  handoff_message: string;
  is_active: boolean;
  created_at: string;
}

function check(error: { message: string } | null | undefined): void {
  if (error) throw new Error(`Supabase: ${error.message}`);
}

function toInboxRow(r: InboxViewRow): InboxRow {
  return {
    id: r.id,
    contactPhone: r.contact_phone,
    status: r.status,
    instance: { id: r.instance_id, name: r.instance_name },
    handoffSummary: r.handoff_summary,
    handoffAt: r.handoff_at,
    assignedTo: r.assigned_to,
    assignedAt: r.assigned_at,
    crmClientId: r.crm_client_id,
    crmLinkVia: r.crm_link_via,
    lastMessageAt: r.last_message_at,
    lastMessage:
      r.last_direction && r.last_content !== null && r.last_created_at
        ? { direction: r.last_direction, content: r.last_content, createdAt: r.last_created_at }
        : null,
  };
}

function toAgentRow(r: AgentDbRow): AgentRow {
  return {
    id: r.id,
    instanceId: r.instance_id,
    name: r.name,
    provider: r.provider,
    model: r.model,
    systemPrompt: r.system_prompt,
    handoffMessage: r.handoff_message,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}

function agentPayload(input: AgentInput) {
  return {
    name: input.name,
    provider: input.provider,
    model: input.model,
    system_prompt: input.systemPrompt,
    ...(input.handoffMessage !== undefined && { handoff_message: input.handoffMessage }),
    is_active: input.isActive,
  };
}

export function createSupabaseDashboardStore(supabase: SupabaseClient): DashboardStore {
  return {
    async listInbox(view: InboxView, userId: string) {
      let query = supabase.from("conversation_inbox").select(INBOX_COLUMNS);
      if (view === "all") {
        query = query.eq("status", "open").order("last_message_at", { ascending: false, nullsFirst: false }).limit(ALL_LIMIT);
      } else {
        query = query.eq("status", "awaiting_human");
        if (view === "mine") query = query.eq("assigned_to", userId);
        query = query.order("handoff_at", { ascending: true }).limit(HANDOFF_LIMIT);
      }
      const { data, error } = await query;
      check(error);
      return ((data as InboxViewRow[] | null) ?? []).map(toInboxRow);
    },

    async countInbox(userId: string) {
      const [handoff, mine] = await Promise.all([
        supabase.from("conversations").select("id", { count: "exact", head: true }).eq("status", "awaiting_human"),
        supabase
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("status", "awaiting_human")
          .eq("assigned_to", userId),
      ]);
      check(handoff.error);
      check(mine.error);
      return { handoff: handoff.count ?? 0, mine: mine.count ?? 0 };
    },

    async getInboxRow(id: string) {
      const { data, error } = await supabase.from("conversation_inbox").select(INBOX_COLUMNS).eq("id", id).maybeSingle();
      check(error);
      return data ? toInboxRow(data as InboxViewRow) : null;
    },

    async listMessages(conversationId: string, limit: number) {
      const { data, error } = await supabase
        .from("messages")
        .select("id, direction, role, content, created_at, sent_by")
        .eq("conversation_id", conversationId)
        .order("received_at", { ascending: false })
        .limit(limit);
      check(error);
      const rows = (data as Array<{
        id: string; direction: "in" | "out"; role: string; content: string; created_at: string; sent_by: string | null;
      }> | null) ?? [];
      return rows
        .map((m): MessageRow => ({ id: m.id, direction: m.direction, role: m.role, content: m.content, createdAt: m.created_at, sentBy: m.sent_by }))
        .reverse();
    },

    async assign(conversationId: string, userId: string): Promise<AssignOutcome> {
      const updated = await supabase
        .from("conversations")
        .update({ assigned_to: userId, assigned_at: new Date().toISOString() })
        .eq("id", conversationId)
        .eq("status", "awaiting_human")
        .select("id");
      check(updated.error);
      if (((updated.data as unknown[] | null) ?? []).length > 0) return "ok";

      const existing = await supabase.from("conversations").select("id").eq("id", conversationId).maybeSingle();
      check(existing.error);
      return existing.data ? "not-awaiting" : "not-found";
    },

    async unassign(conversationId: string) {
      const { data, error } = await supabase
        .from("conversations")
        .update({ assigned_to: null, assigned_at: null })
        .eq("id", conversationId)
        .select("id");
      check(error);
      return ((data as unknown[] | null) ?? []).length > 0;
    },

    async displayNames(userIds: string[]) {
      const ids = [...new Set(userIds)];
      const names = new Map<string, string>();
      if (ids.length === 0) return names;

      const { data, error } = await supabase.from("team_members").select("user_id, display_name").in("user_id", ids);
      check(error);
      for (const row of (data as Array<{ user_id: string; display_name: string }> | null) ?? []) {
        names.set(row.user_id, row.display_name);
      }

      // Fall back to the Auth e-mail; a removed user simply stays unnamed.
      await Promise.all(
        ids
          .filter((id) => !names.has(id))
          .map(async (id) => {
            try {
              const result = await supabase.auth.admin.getUserById(id);
              const email = result.data?.user?.email;
              if (!result.error && email) names.set(id, email);
            } catch {
              // ignore: the caller falls back to the id
            }
          }),
      );
      return names;
    },

    async listInstancesWithAgents() {
      const { data, error } = await supabase
        .from("instances")
        .select(`id, name, status, agents(${AGENT_COLUMNS})`)
        .order("created_at", { ascending: true });
      check(error);
      const rows = (data as Array<{ id: string; name: string; status: string; agents: AgentDbRow[] | null }> | null) ?? [];
      return rows.map((r): InstanceWithAgents => ({
        id: r.id,
        name: r.name,
        status: r.status,
        agents: (r.agents ?? []).map(toAgentRow),
      }));
    },

    async instanceExists(instanceId: string) {
      const { data, error } = await supabase.from("instances").select("id").eq("id", instanceId).maybeSingle();
      check(error);
      return data !== null;
    },

    async countAgents(instanceId: string) {
      const { count, error } = await supabase
        .from("agents")
        .select("id", { count: "exact", head: true })
        .eq("instance_id", instanceId);
      check(error);
      return count ?? 0;
    },

    async createAgent(instanceId: string, input: AgentInput) {
      const { data, error } = await supabase
        .from("agents")
        .insert({ instance_id: instanceId, ...agentPayload(input) })
        .select(AGENT_COLUMNS)
        .single();
      check(error);
      return toAgentRow(data as AgentDbRow);
    },

    async updateAgent(id: string, input: AgentInput) {
      const { data, error } = await supabase
        .from("agents")
        .update(agentPayload(input))
        .eq("id", id)
        .select(AGENT_COLUMNS)
        .maybeSingle();
      check(error);
      return data ? toAgentRow(data as AgentDbRow) : null;
    },
  };
}
