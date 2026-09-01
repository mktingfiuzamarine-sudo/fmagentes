export interface Instance {
  id: string;
  name: string;
  evolutionInstanceId: string;
  status: string;
  phoneNumber: string | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  provider: string;
  model: string;
  systemPrompt: string;
  instanceId: string;
  isActive: boolean;
}

export interface Conversation {
  id: string;
  instanceId: string;
  contactPhone: string;
  agentId: string | null;
  status: string;
  lastMessageAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  content: string;
  role: string;
  evolutionMessageId: string | null;
  createdAt: string;
}
