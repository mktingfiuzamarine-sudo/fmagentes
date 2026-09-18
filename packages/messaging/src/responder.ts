export interface AgentConfig {
  id: string;
  name: string;
  provider: string;
  model: string;
  systemPrompt: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ResponderInput {
  /** The agent the conversation is pinned to. */
  agent: AgentConfig;
  /** Chronological, oldest first, including the incoming message. */
  history: HistoryMessage[];
  incoming: HistoryMessage;
}

export interface ResponderPort {
  /** Returns the reply text, or null to deliberately not answer. */
  generate(input: ResponderInput): Promise<string | null>;
}

/**
 * The only responder sub-project 3 ships. It ignores `agent` and `history` on
 * purpose — sub-project 4 replaces this class and nothing else.
 */
export class EchoResponder implements ResponderPort {
  async generate(input: ResponderInput): Promise<string | null> {
    const text = input.incoming.content.trim();
    if (text.length === 0) return null;
    return `Echo: ${text}`;
  }
}
