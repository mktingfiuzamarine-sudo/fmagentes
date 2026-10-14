export interface AgentConfig {
  id: string;
  name: string;
  provider: string;
  model: string;
  systemPrompt: string;
  /** Sent to the customer when the conversation is handed to a human. */
  handoffMessage: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/**
 * What the code knows about the customer before the model runs. A name is only
 * present when the link proves who is typing (phone match or created by us).
 */
export type CustomerContext = { status: "registered"; name?: string } | { status: "unregistered" };

/** A CRM link the responder made during the call; messaging persists it. */
export interface LinkedCustomer {
  crmClientId: string;
  via: "cpf" | "created";
}

export type ResponderResult =
  | { kind: "reply"; text: string; linkedCustomer?: LinkedCustomer }
  | { kind: "handoff"; summary: string; linkedCustomer?: LinkedCustomer }
  | { kind: "decline"; linkedCustomer?: LinkedCustomer };

export interface ResponderInput {
  /** The agent the conversation is pinned to. */
  agent: AgentConfig;
  /** Chronological, oldest first, including the incoming message. */
  history: HistoryMessage[];
  incoming: HistoryMessage;
  conversationId: string;
  contactPhone: string;
  customer: CustomerContext;
}

export interface ResponderPort {
  generate(input: ResponderInput): Promise<ResponderResult>;
}

/**
 * The agent itself is misconfigured (unknown provider or model, rejected API
 * key). Retrying cannot fix it, so the worker fails the job permanently.
 */
export class ResponderConfigurationError extends Error {
  constructor(
    public readonly agentId: string,
    message: string,
  ) {
    super(message);
    this.name = "ResponderConfigurationError";
  }
}

/** Kept for tests and local runs without an LLM. Ignores agent and history. */
export class EchoResponder implements ResponderPort {
  async generate(input: ResponderInput): Promise<ResponderResult> {
    const text = input.incoming.content.trim();
    if (text.length === 0) return { kind: "decline" };
    return { kind: "reply", text: `Echo: ${text}` };
  }
}
