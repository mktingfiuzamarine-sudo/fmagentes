export interface Me {
  id: string;
  email: string | null;
  displayName: string;
  providers: { anthropic: boolean; openai: boolean };
}

export interface Person {
  id: string;
  displayName: string;
}

export interface ConversationListItem {
  id: string;
  contactPhone: string;
  instance: { id: string; name: string };
  status: "open" | "awaiting_human";
  handoffSummary: string | null;
  handoffAt: string | null;
  assignedTo: Person | null;
  lastMessage: { direction: "in" | "out"; content: string; createdAt: string } | null;
  awaitingReply: boolean;
  crmLinkVia: "phone" | "cpf" | "created" | null;
}

export interface InboxResponse {
  items: ConversationListItem[];
  counts: { handoff: number; mine: number };
}

export interface ChatMessage {
  id: string;
  direction: "in" | "out";
  role: string;
  content: string;
  createdAt: string;
  sentBy: Person | null;
}

export type CustomerView =
  | { linkVia: null }
  | { linkVia: "phone" | "created"; name: string | null }
  | { linkVia: "cpf"; unverified: true };

export interface ConversationDetail extends ConversationListItem {
  messages: ChatMessage[];
  customer: CustomerView;
}

export interface AgentDto {
  id: string;
  instanceId: string;
  name: string;
  provider: "anthropic" | "openai";
  model: string;
  systemPrompt: string;
  handoffMessage: string;
  isActive: boolean;
}

export interface AgentListRow {
  instance: { id: string; name: string; status: string };
  agent: AgentDto | null;
}

export interface InstanceRow {
  id: string;
  name: string;
  evolution_instance_id: string;
  status: string;
  phone_number: string | null;
  created_at: string;
}

export interface QrResponse {
  qrcode: string | null;
  pairingCode: string | null;
}
