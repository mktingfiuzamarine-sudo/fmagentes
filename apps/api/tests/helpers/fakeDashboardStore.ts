import { vi } from "vitest";
import type { AgentRow, DashboardStore, InboxRow } from "../../src/dashboard/store";

export const CONV_ID = "6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b";
export const INSTANCE_ID = "1a2b3c4d-1111-4222-8333-944455566677";
export const AGENT_ID = "9f8e7d6c-2222-4333-8444-955566677788";

export function inboxRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: CONV_ID,
    contactPhone: "5511900000002",
    status: "awaiting_human",
    instance: { id: INSTANCE_ID, name: "loja" },
    handoffSummary: "Quer orçamento",
    handoffAt: "2026-10-15T12:00:00.000Z",
    assignedTo: null,
    assignedAt: null,
    crmClientId: null,
    crmLinkVia: null,
    lastMessageAt: "2026-10-15T12:00:01.000Z",
    lastMessage: { direction: "in", content: "Alguém aí?", createdAt: "2026-10-15T12:00:01.000Z" },
    ...overrides,
  };
}

export function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: AGENT_ID,
    instanceId: INSTANCE_ID,
    name: "Atendente",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    systemPrompt: "Você atende a Loja Exemplo.",
    handoffMessage: "Vou te passar para um atendente, já já alguém te responde.",
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Every method is a vi.fn with a harmless default; override per test. */
export function fakeDashboardStore(overrides: Partial<DashboardStore> = {}): DashboardStore {
  return {
    listInbox: vi.fn().mockResolvedValue([]),
    countInbox: vi.fn().mockResolvedValue({ handoff: 0, mine: 0 }),
    getInboxRow: vi.fn().mockResolvedValue(null),
    listMessages: vi.fn().mockResolvedValue([]),
    assign: vi.fn().mockResolvedValue("ok"),
    unassign: vi.fn().mockResolvedValue(true),
    displayNames: vi.fn().mockResolvedValue(new Map()),
    listInstancesWithAgents: vi.fn().mockResolvedValue([]),
    instanceExists: vi.fn().mockResolvedValue(true),
    countAgents: vi.fn().mockResolvedValue(0),
    createAgent: vi.fn().mockResolvedValue(agentRow()),
    updateAgent: vi.fn().mockResolvedValue(agentRow()),
    ...overrides,
  };
}
