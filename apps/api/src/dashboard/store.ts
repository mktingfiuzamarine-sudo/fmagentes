export type InboxView = "handoff" | "all" | "mine";
export type ConversationStatus = "open" | "awaiting_human";
export type CrmLinkVia = "phone" | "cpf" | "created";
export type AssignOutcome = "ok" | "not-found" | "not-awaiting";

export interface InboxRow {
  id: string;
  contactPhone: string;
  status: ConversationStatus;
  instance: { id: string; name: string };
  handoffSummary: string | null;
  handoffAt: string | null;
  assignedTo: string | null;
  assignedAt: string | null;
  crmClientId: string | null;
  crmLinkVia: CrmLinkVia | null;
  lastMessageAt: string | null;
  lastMessage: { direction: "in" | "out"; content: string; createdAt: string } | null;
}

export interface MessageRow {
  id: string;
  direction: "in" | "out";
  role: string;
  content: string;
  createdAt: string;
  sentBy: string | null;
}

export interface AgentRow {
  id: string;
  instanceId: string;
  name: string;
  provider: string;
  model: string;
  systemPrompt: string;
  handoffMessage: string;
  isActive: boolean;
  createdAt: string;
}

export interface AgentInput {
  name: string;
  provider: "anthropic" | "openai";
  model: string;
  systemPrompt: string;
  /** Omitted on create = the column default. */
  handoffMessage?: string;
  isActive: boolean;
}

export interface InstanceWithAgents {
  id: string;
  name: string;
  status: string;
  agents: AgentRow[];
}

/** Everything the dashboard routes read or write in the fmagentes database. */
export interface DashboardStore {
  /** handoff: awaiting_human, oldest handoff first. mine: handoff assigned to userId. all: open, newest first (100). */
  listInbox(view: InboxView, userId: string): Promise<InboxRow[]>;
  countInbox(userId: string): Promise<{ handoff: number; mine: number }>;
  getInboxRow(id: string): Promise<InboxRow | null>;
  /** Latest `limit` messages, returned in chronological order. */
  listMessages(conversationId: string, limit: number): Promise<MessageRow[]>;
  assign(conversationId: string, userId: string): Promise<AssignOutcome>;
  /** false when the conversation does not exist. */
  unassign(conversationId: string): Promise<boolean>;
  /** team_members.display_name, else the Auth e-mail; ids that resolve to nothing are absent. */
  displayNames(userIds: string[]): Promise<Map<string, string>>;
  listInstancesWithAgents(): Promise<InstanceWithAgents[]>;
  instanceExists(instanceId: string): Promise<boolean>;
  countAgents(instanceId: string): Promise<number>;
  createAgent(instanceId: string, input: AgentInput): Promise<AgentRow>;
  /** null when the agent does not exist. */
  updateAgent(id: string, input: AgentInput): Promise<AgentRow | null>;
}

/** The agent a number uses: oldest active (same rule as the worker), else the newest. */
export function pickAgent(agents: AgentRow[]): AgentRow | null {
  const byCreated = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return byCreated.find((agent) => agent.isActive) ?? byCreated.at(-1) ?? null;
}
