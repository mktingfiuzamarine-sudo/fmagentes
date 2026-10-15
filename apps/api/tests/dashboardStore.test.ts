import { describe, expect, it } from "vitest";
import { createSupabaseDashboardStore } from "../src/dashboard/supabaseStore";
import { pickAgent } from "../src/dashboard/store";
import { isUuid } from "../src/dashboard/uuid";
import { createSupabaseMock, type TableCall } from "./helpers/supabaseMock";
import { agentRow } from "./helpers/fakeDashboardStore";

const VIEW_ROW = {
  id: "c1",
  instance_id: "i1",
  instance_name: "loja",
  contact_phone: "5511900000002",
  status: "awaiting_human",
  handoff_summary: "Quer orçamento",
  handoff_at: "2026-10-15T12:00:00Z",
  assigned_to: null,
  assigned_at: null,
  crm_client_id: "crm-1",
  crm_link_via: "phone",
  last_message_at: "2026-10-15T12:00:01Z",
  last_direction: "in",
  last_content: "Alguém aí?",
  last_created_at: "2026-10-15T12:00:01Z",
};

describe("createSupabaseDashboardStore", () => {
  it("lists handoff conversations oldest handoff first and maps the view row", async () => {
    let recorded: TableCall = [];
    const supabase = createSupabaseMock({
      conversation_inbox: (calls) => {
        recorded = calls;
        return { data: [VIEW_ROW], error: null };
      },
    });

    const rows = await createSupabaseDashboardStore(supabase as never).listInbox("handoff", "u1");

    expect(recorded).toContainEqual({ op: "eq", args: ["status", "awaiting_human"] });
    expect(recorded).toContainEqual({ op: "order", args: ["handoff_at", { ascending: true }] });
    expect(recorded.some((c) => c.op === "eq" && c.args[0] === "assigned_to")).toBe(false);
    expect(rows).toEqual([
      {
        id: "c1",
        contactPhone: "5511900000002",
        status: "awaiting_human",
        instance: { id: "i1", name: "loja" },
        handoffSummary: "Quer orçamento",
        handoffAt: "2026-10-15T12:00:00Z",
        assignedTo: null,
        assignedAt: null,
        crmClientId: "crm-1",
        crmLinkVia: "phone",
        lastMessageAt: "2026-10-15T12:00:01Z",
        lastMessage: { direction: "in", content: "Alguém aí?", createdAt: "2026-10-15T12:00:01Z" },
      },
    ]);
  });

  it("filters mine by assignee and all by open status newest first", async () => {
    const chains: TableCall[] = [];
    const supabase = createSupabaseMock({
      conversation_inbox: (calls) => {
        chains.push(calls);
        return { data: [], error: null };
      },
    });
    const store = createSupabaseDashboardStore(supabase as never);

    await store.listInbox("mine", "u1");
    await store.listInbox("all", "u1");

    expect(chains[0]).toContainEqual({ op: "eq", args: ["assigned_to", "u1"] });
    expect(chains[1]).toContainEqual({ op: "eq", args: ["status", "open"] });
    expect(chains[1]).toContainEqual({ op: "order", args: ["last_message_at", { ascending: false, nullsFirst: false }] });
    expect(chains[1]).toContainEqual({ op: "limit", args: [100] });
  });

  it("maps a conversation with no messages to lastMessage null", async () => {
    const supabase = createSupabaseMock({
      conversation_inbox: () => ({ data: { ...VIEW_ROW, last_direction: null, last_content: null, last_created_at: null }, error: null }),
    });
    const row = await createSupabaseDashboardStore(supabase as never).getInboxRow("c1");
    expect(row?.lastMessage).toBeNull();
  });

  it("returns messages in chronological order", async () => {
    const supabase = createSupabaseMock({
      messages: () => ({
        data: [
          { id: "m2", direction: "out", role: "assistant", content: "b", created_at: "2", sent_by: "u1" },
          { id: "m1", direction: "in", role: "user", content: "a", created_at: "1", sent_by: null },
        ],
        error: null,
      }),
    });
    const messages = await createSupabaseDashboardStore(supabase as never).listMessages("c1", 100);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messages[1]).toEqual({ id: "m2", direction: "out", role: "assistant", content: "b", createdAt: "2", sentBy: "u1" });
  });

  it("assign: ok, not-awaiting and not-found", async () => {
    const make = (updated: unknown[], exists: boolean) =>
      createSupabaseDashboardStore(
        createSupabaseMock({
          conversations: (calls) =>
            calls.some((c) => c.op === "update")
              ? { data: updated, error: null }
              : { data: exists ? { id: "c1" } : null, error: null },
        }) as never,
      );

    expect(await make([{ id: "c1" }], true).assign("c1", "u1")).toBe("ok");
    expect(await make([], true).assign("c1", "u1")).toBe("not-awaiting");
    expect(await make([], false).assign("c1", "u1")).toBe("not-found");
  });

  it("displayNames: team_members first, then the Auth e-mail, unknown ids absent", async () => {
    const supabase = createSupabaseMock(
      { team_members: () => ({ data: [{ user_id: "u1", display_name: "Rafael" }], error: null }) },
      {
        getUserById: async (id) =>
          id === "u2" ? { data: { user: { email: "ana@x.com" } }, error: null } : { data: { user: null }, error: { message: "nope" } },
      },
    );

    const names = await createSupabaseDashboardStore(supabase as never).displayNames(["u1", "u2", "u3", "u1"]);

    expect(Object.fromEntries(names)).toEqual({ u1: "Rafael", u2: "ana@x.com" });
  });

  it("displayNames with no ids does not query", async () => {
    let queried = false;
    const supabase = createSupabaseMock({ team_members: () => ((queried = true), { data: [], error: null }) });
    expect((await createSupabaseDashboardStore(supabase as never).displayNames([])).size).toBe(0);
    expect(queried).toBe(false);
  });

  it("lists instances with their agents mapped", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({
        data: [
          {
            id: "i1",
            name: "loja",
            status: "connected",
            agents: [
              { id: "a1", instance_id: "i1", name: "A", provider: "openai", model: "gpt-4o-mini", system_prompt: "p", handoff_message: "h", is_active: true, created_at: "1" },
            ],
          },
        ],
        error: null,
      }),
    });
    const list = await createSupabaseDashboardStore(supabase as never).listInstancesWithAgents();
    expect(list[0].agents[0]).toEqual({
      id: "a1", instanceId: "i1", name: "A", provider: "openai", model: "gpt-4o-mini",
      systemPrompt: "p", handoffMessage: "h", isActive: true, createdAt: "1",
    });
  });

  it("createAgent omits handoff_message when not given", async () => {
    let payload: unknown;
    const supabase = createSupabaseMock({
      agents: (calls) => {
        payload = calls.find((c) => c.op === "insert")?.args[0];
        return { data: { id: "a1", instance_id: "i1", name: "A", provider: "openai", model: "m", system_prompt: "", handoff_message: "default", is_active: true, created_at: "1" }, error: null };
      },
    });
    await createSupabaseDashboardStore(supabase as never).createAgent("i1", {
      name: "A", provider: "openai", model: "m", systemPrompt: "", isActive: true,
    });
    expect(payload).toEqual({ instance_id: "i1", name: "A", provider: "openai", model: "m", system_prompt: "", is_active: true });
  });

  it("throws on a Supabase error", async () => {
    const supabase = createSupabaseMock({ conversation_inbox: () => ({ data: null, error: { message: "boom" } }) });
    await expect(createSupabaseDashboardStore(supabase as never).listInbox("handoff", "u1")).rejects.toThrow("boom");
  });
});

describe("pickAgent", () => {
  it("prefers the oldest active agent, else the newest", () => {
    const old = agentRow({ id: "old", createdAt: "1", isActive: false });
    const mid = agentRow({ id: "mid", createdAt: "2", isActive: true });
    const recent = agentRow({ id: "new", createdAt: "3", isActive: true });
    expect(pickAgent([recent, old, mid])?.id).toBe("mid");
    expect(pickAgent([old, agentRow({ id: "x", createdAt: "5", isActive: false })])?.id).toBe("x");
    expect(pickAgent([])).toBeNull();
  });
});

describe("isUuid", () => {
  it("accepts uuids only", () => {
    expect(isUuid("6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b")).toBe(true);
    expect(isUuid("c1")).toBe(false);
    expect(isUuid("6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b'--")).toBe(false);
  });
});
