import { vi } from "vitest";
import type { InboundContext, RespondStore } from "../../src/respondStore";
import type { AgentConfig, HistoryMessage } from "../../src/responder";

export const AGENT: AgentConfig = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  systemPrompt: "Seja breve.",
  handoffMessage: "Já te passo para um atendente.",
};

export const INBOUND: InboundContext = {
  messageId: "msg-in",
  conversationId: "conv-1",
  instanceId: "inst-1",
  agentId: "agent-1",
  contactPhone: "5511999998888",
  content: "ola",
  // Device clock a year behind on purpose: nothing but history ordering may use it.
  createdAt: "2025-10-14T12:00:00Z",
  receivedAt: "2026-10-14T12:00:00.000Z",
  conversationStatus: "open",
  handoffAt: null,
  crmClientId: null,
  crmLinkVia: null,
};

export interface FakeStoreOptions {
  inbound?: Partial<InboundContext> | null;
  agent?: AgentConfig | null;
  answered?: boolean;
  history?: HistoryMessage[];
}

export function createFakeStore(options: FakeStoreOptions = {}) {
  const inbound = options.inbound === null ? null : { ...INBOUND, ...options.inbound };
  return {
    loadInbound: vi.fn(async (_messageId: string) => inbound),
    resolveAgent: vi.fn(async (_input: { conversationId: string; instanceId: string; agentId: string | null }) =>
      options.agent === undefined ? AGENT : options.agent,
    ),
    hasOutboundAfter: vi.fn(async (_conversationId: string, _receivedAt: string) => options.answered ?? false),
    loadHistory: vi.fn(
      async (_conversationId: string, _limit: number): Promise<HistoryMessage[]> =>
        options.history ?? [{ role: "user", content: "ola", createdAt: INBOUND.createdAt }],
    ),
    linkCustomer: vi.fn(async (_conversationId: string, _crmClientId: string, _via: string) => {}),
    markAwaitingHuman: vi.fn(async (_conversationId: string, _handoff: { summary: string; handoffAt: string }) => {}),
  } satisfies RespondStore;
}
