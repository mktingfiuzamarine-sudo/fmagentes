# Dashboard completo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small team runs the WhatsApp agents from the browser: an inbox centred on handed-off conversations (assume, reply, give back to the bot), one agent per number (edit prompt/provider/model/handoff message/active), and number management (create, QR pairing, status, remove).

**Architecture:** The browser talks only to `apps/api`, through a same-origin Next rewrite (`/api/*` → API) carrying the Supabase access token. New API routes read/write through a `DashboardStore` port (Supabase implementation + in-memory fake in route tests), backed by a new `conversation_inbox` view. Dashboard pages are client components polling every 10 s while visible.

**Tech Stack:** TypeScript (strict), pnpm 9 workspaces, Turbo, Fastify 4, Zod 3, Supabase JS 2, Vitest 2, Next.js 14 (app router), React 18, CSS Modules.

**Spec:** `docs/superpowers/specs/2026-10-15-dashboard-design.md`

## Global Constraints

- Node `>=22`, `pnpm@9.12.0`. Python does not exist on this machine — never use `python`.
- The browser never talks to the fmagentes Supabase database; only to `apps/api` via `/api/*`.
- Every new API route lives in the authenticated scope (`app.register` block in `apps/api/src/app.ts`): 401 no/invalid token, 403 not allowlisted.
- A malformed UUID path parameter → 404 (never a Postgres cast error / 500).
- Max lengths: reply text **4096**, system prompt **20000**, handoff message **1000**, agent name **100**, model **100**.
- `provider` ∈ `anthropic`, `openai`.
- Polling interval **10 s**, only while `document.visibilityState === "visible"`.
- A CPF-linked customer's (`crm_link_via = 'cpf'`) name is never sent to the browser.
- UI text in Portuguese; code identifiers and comments in English.
- No component library; CSS Modules only. Do not trigger `window.alert/confirm/prompt` — confirmations are inline UI.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm --filter` may print "No projects matched" because of drive-letter case: run commands from `C:/Users/Dell/desktop/fmagentes` or `cd` into the package and run `npx vitest run` / `npx tsc --noEmit`; judge by exit codes.
- Full suite: `pnpm exec turbo run build test --force` (`pnpm test --force` is NOT valid). Redis-backed tests need `docker compose up -d redis`.

### Refinements to the spec (decided while planning — record them in ROADMAP in Task 11)

1. **`DashboardStore` port** in `apps/api/src/dashboard/store.ts` (Supabase implementation + fake for route tests), same pattern as messaging's `RespondStore`. `AppDependencies.dashboard?` defaults to the Supabase store.
2. **`conversation_inbox` view** (migration 0005): conversation + instance name + latest message (by `received_at`), so the list is one query.
3. **CRM name lookup** is a 10-line `CustomerNamePort` in the API (`clients.name` by id) instead of reusing `packages/agent`'s adapter, which requires an `agentUserId` the API does not have.
4. **`AppConfig.providers?`** and **`AppDependencies.customerNames?`** are optional so existing route tests keep compiling.
5. **The QR panel** fetches the QR once (plus a "Gerar novo QR" button) and polls the instance list for status; polling `/instances/:id/qr` would ask Evolution for a new code every 10 s.

## Review Focus

1. Malformed or unknown conversation/agent id on `GET /conversations/:id`, assign, unassign, `PUT /agents/:id` → 404, never 500 (Task 5, Task 6 tests).
2. CRM unreachable or not configured → conversation detail still 200 with `name: null`; a CPF link never returns a name (Task 5 tests).
3. A reply that is whitespace-only or longer than 4096 chars → 400, nothing sent (Task 5 test).
4. `awaitingReply` follows the latest message by database receipt time: true after a customer message, false after a human/bot reply (Task 3 test on the view mapping; Task 5 list test).
5. An assignee with no `team_members` row (or a removed user) still renders: falls back to the Auth e-mail, then to the id (Task 3 `displayNames` test).

---

## File Structure

```
supabase/migrations/0005_dashboard.sql            (T1) assignment, sent_by, team_members, conversation_inbox view
packages/messaging/src/sendMessage.ts             (T2) + sentBy
packages/messaging/src/resumeConversation.ts      (T2) clears assignment
apps/api/src/dashboard/uuid.ts                    (T3) isUuid
apps/api/src/dashboard/store.ts                   (T3) DashboardStore port + types + pickAgent
apps/api/src/dashboard/supabaseStore.ts           (T3) createSupabaseDashboardStore
apps/api/tests/helpers/supabaseMock.ts            (T3) chainable Supabase mock
apps/api/tests/helpers/fakeDashboardStore.ts      (T3) fake store for route tests
apps/api/src/dashboard/customerNames.ts           (T4) CustomerNamePort + Supabase impl
apps/api/src/env.ts, src/index.ts, src/app.ts     (T4) optional LLM/CRM env, providers, wiring
apps/api/src/routes/me.ts                         (T4) GET /me
apps/api/src/dashboard/present.ts                 (T5) DTO mapping, resolveCustomer
apps/api/src/routes/inbox.ts                      (T5) list, detail, assign, unassign
apps/api/src/routes/conversations.ts              (T5) sent_by + 4096 limit
apps/api/src/routes/agents.ts                     (T6) GET/POST/PUT agents
apps/dashboard/next.config.js                     (T7) /api rewrite
apps/dashboard/lib/{api,browserApi,usePolling,useMe,format,replyGate,types}.ts (T7)
apps/dashboard/app/globals.css, app/dashboard/{layout,DashboardShell}.tsx, ui.module.css (T7)
apps/dashboard/app/dashboard/inbox/*              (T8)
apps/dashboard/app/dashboard/agents/*             (T9)
apps/dashboard/app/dashboard/instances/*          (T10)
docs/ROADMAP.md                                   (T11)
```

---

### Task 1: Migration 0005

**Files:**
- Create: `supabase/migrations/0005_dashboard.sql`

**Interfaces:**
- Produces: columns `conversations.assigned_to uuid`, `conversations.assigned_at timestamptz`, `messages.sent_by uuid`; table `team_members(user_id uuid pk, display_name text, created_at)`; view `conversation_inbox` with columns `id, instance_id, instance_name, contact_phone, status, handoff_summary, handoff_at, assigned_to, assigned_at, crm_client_id, crm_link_via, last_message_at, last_direction, last_content, last_created_at`.

- [ ] **Step 1: Write the migration**

```sql
-- Sub-project 5: dashboard. Advisory assignment, author of human messages,
-- team display names and a one-query inbox view.

alter table conversations
  add column assigned_to uuid,
  add column assigned_at timestamptz;

comment on column conversations.assigned_to is
  'auth.users.id of the attendant who took the handoff (advisory, no FK: auth schema).';

alter table messages
  add column sent_by uuid;

comment on column messages.sent_by is
  'auth.users.id of the human who sent this outbound message; null for bot and customer.';

create table team_members (
  user_id uuid primary key,
  display_name text not null check (length(trim(display_name)) > 0),
  created_at timestamptz not null default now()
);

alter table team_members enable row level security;
create policy "authenticated_full_access" on team_members
  for all to authenticated using (true) with check (true);

create index idx_conversations_status_last on conversations (status, last_message_at);
create index idx_messages_conversation_received on messages (conversation_id, received_at desc);

-- One row per conversation with its number's name and latest message
-- (database receipt order, so device clocks cannot reorder it).
create view conversation_inbox
with (security_invoker = true) as
select
  c.id,
  c.instance_id,
  i.name as instance_name,
  c.contact_phone,
  c.status,
  c.handoff_summary,
  c.handoff_at,
  c.assigned_to,
  c.assigned_at,
  c.crm_client_id,
  c.crm_link_via,
  c.last_message_at,
  lm.direction as last_direction,
  lm.content as last_content,
  lm.created_at as last_created_at
from conversations c
join instances i on i.id = c.instance_id
left join lateral (
  select m.direction, m.content, m.created_at
  from messages m
  where m.conversation_id = c.id
  order by m.received_at desc
  limit 1
) lm on true;
```

- [ ] **Step 2: Apply to the fmagentes database**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id = odqqiteoskmfpwrlqyrb`, `name = dashboard`, `query` = the file contents. (If the tool is unavailable to you, stop and report NEEDS_CONTEXT — the controller applies it.) If the project is paused (`get_project` status `INACTIVE`), report it; the user must restore it from the Supabase dashboard.

- [ ] **Step 3: Verify**

Run via `mcp__plugin_supabase_supabase__execute_sql`:

```sql
select id, status, last_direction, left(last_content, 40) from conversation_inbox order by last_message_at desc limit 5;
select column_name from information_schema.columns where table_name = 'messages' and column_name = 'sent_by';
```

Expected: rows for the existing test conversations with a non-null `last_direction`; one row `sent_by`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0005_dashboard.sql
git commit -m "feat(db): migration 0005 - assignment, sent_by, team_members, inbox view"
```

---

### Task 2: Messaging — author of human sends, resume clears assignment

**Files:**
- Modify: `packages/messaging/src/sendMessage.ts`
- Modify: `packages/messaging/src/resumeConversation.ts`
- Test: `packages/messaging/tests/sendMessage.test.ts`, `packages/messaging/tests/resumeConversation.test.ts`

**Interfaces:**
- Produces: `sendMessage(deps, { conversationId, text, answersThrough?, sentBy?: string })` — writes `sent_by` when `sentBy` is given. `resumeConversation` update payload becomes `{ status: "open", handoff_summary: null, handoff_at: null, assigned_to: null, assigned_at: null }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/messaging/tests/sendMessage.test.ts` inside `describe("sendMessage", ...)`:

```ts
  it("writes sent_by on the outbound row when a human sends", async () => {
    const inserts: unknown[] = [];
    const supabase = createSupabaseMock({
      conversations: () => ({
        data: { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } },
        error: null,
      }),
      messages: (calls) => {
        const insert = calls.find((c) => c.op === "insert");
        if (insert) inserts.push(insert.args[0]);
        return { data: { id: "msg-1", conversation_id: "conv-1", direction: "out", content: "hi", created_at: "x" }, error: null };
      },
    });
    const evolutionApi = { sendText: vi.fn().mockResolvedValue({ messageId: "EVO1" }) };

    await sendMessage({ supabase, evolutionApi } as never, { conversationId: "conv-1", text: "hi", sentBy: "user-1" });

    expect(inserts).toEqual([expect.objectContaining({ sent_by: "user-1" })]);
    expect(inserts[0]).not.toHaveProperty("answers_through");
  });
```

In `packages/messaging/tests/resumeConversation.test.ts`, change the expected update in "reopens the conversation and clears the handoff" to:

```ts
      { op: "update", args: [{ status: "open", handoff_summary: null, handoff_at: null, assigned_to: null, assigned_at: null }] },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/messaging && npx vitest run tests/sendMessage.test.ts tests/resumeConversation.test.ts`
Expected: 2 FAIL (no `sent_by`; update payload mismatch).

- [ ] **Step 3: Implement**

In `sendMessage.ts`, extend the input type (after `answersThrough?: string;`):

```ts
    /** Human sends only: auth.users.id of the attendant. */
    sentBy?: string;
```

and the insert payload (after the `answers_through` spread):

```ts
      ...(input.sentBy !== undefined && { sent_by: input.sentBy }),
```

In `resumeConversation.ts`, replace the update payload and the doc comment's first line:

```ts
/**
 * Hands a conversation back to the agent and clears its handoff and
 * assignment. Idempotent: resuming an open conversation succeeds. A malformed
 * id is "not found" rather than a uuid cast error from Postgres.
 */
```

```ts
    .update({ status: "open", handoff_summary: null, handoff_at: null, assigned_to: null, assigned_at: null })
```

- [ ] **Step 4: Run the package tests**

Run: `cd packages/messaging && npx vitest run && npx tsc --noEmit`
Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/messaging/src/sendMessage.ts packages/messaging/src/resumeConversation.ts packages/messaging/tests/sendMessage.test.ts packages/messaging/tests/resumeConversation.test.ts
git commit -m "feat(messaging): record the human sender and clear assignment on resume"
```

---

### Task 3: DashboardStore (port, Supabase implementation, test helpers)

**Files:**
- Create: `apps/api/src/dashboard/uuid.ts`
- Create: `apps/api/src/dashboard/store.ts`
- Create: `apps/api/src/dashboard/supabaseStore.ts`
- Create: `apps/api/tests/helpers/supabaseMock.ts`
- Create: `apps/api/tests/helpers/fakeDashboardStore.ts`
- Test: `apps/api/tests/dashboardStore.test.ts`

**Interfaces:**
- Consumes: migration 0005 (Task 1) column/view names.
- Produces (exact, later tasks rely on them):
  - `isUuid(value: string): boolean`
  - types `InboxView = "handoff" | "all" | "mine"`, `ConversationStatus = "open" | "awaiting_human"`, `CrmLinkVia = "phone" | "cpf" | "created"`, `InboxRow`, `MessageRow`, `AgentRow`, `AgentInput`, `InstanceWithAgents`, `AssignOutcome = "ok" | "not-found" | "not-awaiting"`
  - `interface DashboardStore` (methods below), `pickAgent(agents: AgentRow[]): AgentRow | null`
  - `createSupabaseDashboardStore(supabase: SupabaseClient): DashboardStore`
  - test helpers `createSupabaseMock(handlers, options?)`, `fakeDashboardStore(overrides?)`, `inboxRow(overrides?)`, `agentRow(overrides?)`

- [ ] **Step 1: Write `uuid.ts` and `store.ts` (types only, no logic to test except `pickAgent`)**

`apps/api/src/dashboard/uuid.ts`:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path params are checked before querying, so a bad id is a 404, not a cast error. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
```

`apps/api/src/dashboard/store.ts`:

```ts
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
```

- [ ] **Step 2: Write the test helpers**

`apps/api/tests/helpers/supabaseMock.ts`:

```ts
import { vi } from "vitest";

export type TableCall = { op: string; args: unknown[] }[];
export type TableResult = { data: unknown; error: unknown; count?: number | null };

/**
 * Chainable Supabase mock: `handlers` maps a table/view name to a function
 * that gets the recorded call chain and returns what the awaited query
 * resolves to. `getUserById` backs `auth.admin.getUserById`.
 */
export function createSupabaseMock(
  handlers: Record<string, (calls: TableCall) => TableResult>,
  options: { getUserById?: (id: string) => Promise<{ data: { user: { email?: string } | null }; error: unknown }> } = {},
) {
  return {
    from(table: string) {
      const calls: TableCall = [];
      const result = () => handlers[table]?.(calls) ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "insert", "update", "delete", "eq", "in", "order", "limit"]) {
        chain[op] = vi.fn((...args: unknown[]) => {
          calls.push({ op, args });
          return chain;
        });
      }
      chain.single = vi.fn(async () => result());
      chain.maybeSingle = vi.fn(async () => result());
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return chain;
    },
    auth: {
      admin: {
        getUserById: vi.fn(options.getUserById ?? (async () => ({ data: { user: null }, error: null }))),
      },
    },
  };
}
```

`apps/api/tests/helpers/fakeDashboardStore.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing store tests**

`apps/api/tests/dashboardStore.test.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify failure**

Run: `cd apps/api && npx vitest run tests/dashboardStore.test.ts`
Expected: FAIL — cannot resolve `../src/dashboard/supabaseStore`.

- [ ] **Step 5: Implement `supabaseStore.ts`**

```ts
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
```

- [ ] **Step 6: Run tests and type-check**

Run: `cd apps/api && npx vitest run tests/dashboardStore.test.ts && npx tsc --noEmit`
Expected: PASS, exit 0. (If `tsc` rejects reassigning `query`, do not widen it to `any`: build the `all` and handoff/mine queries as two separate `const` chains and `await` whichever applies.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/dashboard apps/api/tests/helpers/supabaseMock.ts apps/api/tests/helpers/fakeDashboardStore.ts apps/api/tests/dashboardStore.test.ts
git commit -m "feat(api): DashboardStore port with Supabase implementation"
```

---

### Task 4: API config, CRM name lookup and `GET /me`

**Files:**
- Create: `apps/api/src/dashboard/customerNames.ts`
- Create: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/env.ts`, `apps/api/src/index.ts`, `apps/api/.env.example`
- Test: `apps/api/tests/me.test.ts`

**Interfaces:**
- Consumes: `DashboardStore`, `createSupabaseDashboardStore` (Task 3).
- Produces:
  - `AppConfig.providers?: { anthropic: boolean; openai: boolean }`
  - `AppDependencies.dashboard?: DashboardStore`, `AppDependencies.customerNames?: CustomerNamePort`
  - `dashboardStore(deps: AppDependencies): DashboardStore` exported from `apps/api/src/app.ts`
  - `interface CustomerNamePort { findName(crmClientId: string): Promise<string | null> }`, `createSupabaseCustomerNames(crm: SupabaseClient): CustomerNamePort`
  - `GET /me` → `{ id, email, displayName, providers }`

- [ ] **Step 1: Write the failing test**

`apps/api/tests/me.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, TEST_USER, testAuth } from "./helpers/auth";
import { fakeDashboardStore } from "./helpers/fakeDashboardStore";

function deps(over: Partial<AppDependencies> = {}): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: testAuth(),
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com", allowedUsers: TEST_ALLOWED_USERS },
    dashboard: fakeDashboardStore(),
    ...over,
  };
}

describe("GET /me", () => {
  it("401 without a token", async () => {
    const app = buildApp(deps());
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    await app.close();
  });

  it("returns the user, the team display name and available providers", async () => {
    const app = buildApp(
      deps({
        dashboard: fakeDashboardStore({ displayNames: vi.fn().mockResolvedValue(new Map([[TEST_USER.id, "Rafael"]])) }),
        config: {
          webhookSecret: "s",
          publicWebhookUrl: "https://cb.example.com",
          allowedUsers: TEST_ALLOWED_USERS,
          providers: { anthropic: true, openai: false },
        },
      }),
    );

    const response = await app.inject({ method: "GET", url: "/me", headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: TEST_USER.id,
      email: TEST_USER.email,
      displayName: "Rafael",
      providers: { anthropic: true, openai: false },
    });
    await app.close();
  });

  it("falls back to the e-mail and to no providers", async () => {
    const app = buildApp(deps());
    const body = (await app.inject({ method: "GET", url: "/me", headers: AUTH_HEADERS })).json();
    expect(body.displayName).toBe(TEST_USER.email);
    expect(body.providers).toEqual({ anthropic: false, openai: false });
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run tests/me.test.ts`
Expected: FAIL — `dashboard` not in `AppDependencies` / 404 on `/me`.

- [ ] **Step 3: Implement**

`apps/api/src/dashboard/customerNames.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

/** Reads a CRM client's name by id. The API never writes to the CRM. */
export interface CustomerNamePort {
  findName(crmClientId: string): Promise<string | null>;
}

export function createSupabaseCustomerNames(crm: SupabaseClient): CustomerNamePort {
  return {
    async findName(crmClientId) {
      const { data, error } = await crm.from("clients").select("name").eq("id", crmClientId).maybeSingle();
      if (error) throw new Error(`CRM: ${error.message}`);
      return (data as { name: string } | null)?.name ?? null;
    },
  };
}
```

`apps/api/src/routes/me.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { dashboardStore, type AppDependencies } from "../app";

const NO_PROVIDERS = { anthropic: false, openai: false };

export function registerMeRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.get("/me", async (request) => {
    const user = request.user!;
    const names = await dashboardStore(deps).displayNames([user.id]);
    return {
      id: user.id,
      email: user.email,
      displayName: names.get(user.id) ?? user.email ?? user.id,
      providers: deps.config.providers ?? NO_PROVIDERS,
    };
  });
}
```

In `apps/api/src/app.ts`:
- add imports:

```ts
import type { DashboardStore } from "./dashboard/store";
import { createSupabaseDashboardStore } from "./dashboard/supabaseStore";
import type { CustomerNamePort } from "./dashboard/customerNames";
import { registerMeRoute } from "./routes/me";
```

- extend `AppConfig` (after `allowedUsers`):

```ts
  /** Which LLM keys the API has; assumed equal to the worker's. */
  providers?: { anthropic: boolean; openai: boolean };
```

- extend `AppDependencies` (after `config`):

```ts
  /** Defaults to the Supabase store over `supabase`. */
  dashboard?: DashboardStore;
  /** Absent when the CRM env vars are not set. */
  customerNames?: CustomerNamePort;
```

- add below the interfaces:

```ts
export function dashboardStore(deps: AppDependencies): DashboardStore {
  return deps.dashboard ?? createSupabaseDashboardStore(deps.supabase);
}
```

- inside the authenticated `app.register` block, add `registerMeRoute(scope, deps);` after `registerConversationRoutes(scope, deps);`.

In `apps/api/src/env.ts`, replace the two LLM lines with:

```ts
  // Optional: only used to tell the dashboard which providers are usable.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Optional CRM access (customer names in the inbox). Both or neither.
  CRM_SUPABASE_URL: z.string().url().optional(),
  CRM_SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
```

In `apps/api/src/index.ts`:
- import `createSupabaseCustomerNames` from `./dashboard/customerNames`;
- before `buildApp`:

```ts
const customerNames =
  env.CRM_SUPABASE_URL && env.CRM_SUPABASE_SERVICE_KEY
    ? createSupabaseCustomerNames(
        createSupabaseClient({ url: env.CRM_SUPABASE_URL, serviceKey: env.CRM_SUPABASE_SERVICE_KEY, timeoutMs: 10_000 }),
      )
    : undefined;
```

- pass `customerNames,` in the `buildApp({...})` deps, and in `config` add:

```ts
    providers: {
      anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
      openai: Boolean(env.OPENAI_API_KEY?.trim()),
    },
```

Append to `apps/api/.env.example`:

```
# Optional: CRM (repo "aula") for customer names in the dashboard inbox
CRM_SUPABASE_URL=
CRM_SUPABASE_SERVICE_KEY=
```

(If `.env.example` lists `ANTHROPIC_API_KEY=`/`OPENAI_API_KEY=` already, leave them; note they are now optional with a comment `# Optional: tells the dashboard which providers are usable`.)

Check `createSupabaseClient`'s config accepts `timeoutMs` (it does: `packages/shared/src/supabaseClient.ts`). An empty `CRM_SUPABASE_URL=` would fail `.url()` — so in `env.ts` use `z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional())` for `CRM_SUPABASE_URL` and the same preprocess with `z.string().min(1).optional()` for `CRM_SUPABASE_SERVICE_KEY`.

- [ ] **Step 4: Run API tests and type-check**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all PASS (existing suites untouched), exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/tests/me.test.ts apps/api/.env.example
git commit -m "feat(api): GET /me, optional LLM/CRM env and dashboard deps"
```

---

### Task 5: Inbox routes

**Files:**
- Create: `apps/api/src/dashboard/present.ts`
- Create: `apps/api/src/routes/inbox.ts`
- Modify: `apps/api/src/routes/conversations.ts`, `apps/api/src/app.ts`
- Test: `apps/api/tests/inbox.test.ts`, `apps/api/tests/conversations.test.ts`

**Interfaces:**
- Consumes: `dashboardStore(deps)`, `AppDependencies.customerNames` (Task 4); `InboxRow`, `MessageRow`, `isUuid` (Task 3); `sendMessage(..., { sentBy })` (Task 2).
- Produces (JSON shapes the dashboard consumes):
  - `ConversationListItem = { id, contactPhone, instance: {id,name}, status, handoffSummary, handoffAt, assignedTo: {id, displayName} | null, lastMessage: {direction, content, createdAt} | null, awaitingReply: boolean, crmLinkVia }`
  - `GET /conversations?view=handoff|all|mine` → `{ items: ConversationListItem[], counts: { handoff, mine } }`
  - `GET /conversations/:id` → `ConversationListItem & { messages: Array<{id, direction, role, content, createdAt, sentBy: {id, displayName} | null}>, customer: CustomerView }` where `CustomerView = { linkVia: null } | { linkVia: "phone" | "created"; name: string | null } | { linkVia: "cpf"; unverified: true }`
  - `POST /conversations/:id/assign` → `{ assignedTo: {id, displayName} }`; `POST /conversations/:id/unassign` → `{ assignedTo: null }`

- [ ] **Step 1: Write the failing tests**

`apps/api/tests/inbox.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, TEST_USER, testAuth } from "./helpers/auth";
import { CONV_ID, fakeDashboardStore, inboxRow } from "./helpers/fakeDashboardStore";
import type { DashboardStore } from "../src/dashboard/store";

function deps(store: DashboardStore, over: Partial<AppDependencies> = {}): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: testAuth(),
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com", allowedUsers: TEST_ALLOWED_USERS },
    dashboard: store,
    ...over,
  };
}

const get = (app: ReturnType<typeof buildApp>, url: string, headers = AUTH_HEADERS) =>
  app.inject({ method: "GET", url, headers });
const post = (app: ReturnType<typeof buildApp>, url: string) => app.inject({ method: "POST", url, headers: AUTH_HEADERS });

describe("GET /conversations", () => {
  it("401 without a token", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    expect((await get(app, "/conversations", {} as never)).statusCode).toBe(401);
    await app.close();
  });

  it("defaults to the handoff view and returns items with counts", async () => {
    const store = fakeDashboardStore({
      listInbox: vi.fn().mockResolvedValue([inboxRow({ assignedTo: "u9" })]),
      countInbox: vi.fn().mockResolvedValue({ handoff: 3, mine: 1 }),
      displayNames: vi.fn().mockResolvedValue(new Map([["u9", "Ana"]])),
    });
    const app = buildApp(deps(store));

    const response = await get(app, "/conversations");

    expect(response.statusCode).toBe(200);
    expect(store.listInbox).toHaveBeenCalledWith("handoff", TEST_USER.id);
    expect(response.json()).toEqual({
      items: [
        {
          id: CONV_ID,
          contactPhone: "5511900000002",
          instance: { id: expect.any(String), name: "loja" },
          status: "awaiting_human",
          handoffSummary: "Quer orçamento",
          handoffAt: "2026-10-15T12:00:00.000Z",
          assignedTo: { id: "u9", displayName: "Ana" },
          lastMessage: { direction: "in", content: "Alguém aí?", createdAt: "2026-10-15T12:00:01.000Z" },
          awaitingReply: true,
          crmLinkVia: null,
        },
      ],
      counts: { handoff: 3, mine: 1 },
    });
    await app.close();
  });

  it("awaitingReply is false when the latest message is outbound, and previews are truncated", async () => {
    const long = "x".repeat(300);
    const store = fakeDashboardStore({
      listInbox: vi.fn().mockResolvedValue([
        inboxRow({ lastMessage: { direction: "out", content: long, createdAt: "t" } }),
      ]),
    });
    const app = buildApp(deps(store));
    const item = (await get(app, "/conversations?view=all")).json().items[0];
    expect(item.awaitingReply).toBe(false);
    expect(item.lastMessage.content).toHaveLength(140);
    expect(item.lastMessage.content.endsWith("…")).toBe(true);
    expect(store.listInbox).toHaveBeenCalledWith("all", TEST_USER.id);
    await app.close();
  });

  it("unknown assignee falls back to the id", async () => {
    const store = fakeDashboardStore({ listInbox: vi.fn().mockResolvedValue([inboxRow({ assignedTo: "gone" })]) });
    const app = buildApp(deps(store));
    expect((await get(app, "/conversations")).json().items[0].assignedTo).toEqual({ id: "gone", displayName: "gone" });
    await app.close();
  });

  it("400 on an unknown view", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    expect((await get(app, "/conversations?view=bogus")).statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /conversations/:id", () => {
  it("404 for a malformed id without querying", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    expect((await get(app, "/conversations/abc")).statusCode).toBe(404);
    expect(store.getInboxRow).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 for an unknown id", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    expect((await get(app, `/conversations/${CONV_ID}`)).statusCode).toBe(404);
    await app.close();
  });

  it("returns messages with authors and the CRM name for a phone link", async () => {
    const store = fakeDashboardStore({
      getInboxRow: vi.fn().mockResolvedValue(inboxRow({ crmClientId: "crm-1", crmLinkVia: "phone" })),
      listMessages: vi.fn().mockResolvedValue([
        { id: "m1", direction: "in", role: "user", content: "oi", createdAt: "1", sentBy: null },
        { id: "m2", direction: "out", role: "assistant", content: "olá", createdAt: "2", sentBy: "u9" },
      ]),
      displayNames: vi.fn().mockResolvedValue(new Map([["u9", "Ana"]])),
    });
    const customerNames = { findName: vi.fn().mockResolvedValue("Carla Mendes") };
    const app = buildApp(deps(store, { customerNames }));

    const body = (await get(app, `/conversations/${CONV_ID}`)).json();

    expect(store.listMessages).toHaveBeenCalledWith(CONV_ID, 100);
    expect(body.messages[0].sentBy).toBeNull();
    expect(body.messages[1].sentBy).toEqual({ id: "u9", displayName: "Ana" });
    expect(body.customer).toEqual({ linkVia: "phone", name: "Carla Mendes" });
    await app.close();
  });

  it("never sends the name of a CPF-linked customer", async () => {
    const store = fakeDashboardStore({
      getInboxRow: vi.fn().mockResolvedValue(inboxRow({ crmClientId: "crm-1", crmLinkVia: "cpf" })),
    });
    const customerNames = { findName: vi.fn().mockResolvedValue("Dono do CPF") };
    const app = buildApp(deps(store, { customerNames }));

    const body = (await get(app, `/conversations/${CONV_ID}`)).json();

    expect(body.customer).toEqual({ linkVia: "cpf", unverified: true });
    expect(customerNames.findName).not.toHaveBeenCalled();
    await app.close();
  });

  it("CRM failure or absence still answers 200 with name null", async () => {
    const store = fakeDashboardStore({
      getInboxRow: vi.fn().mockResolvedValue(inboxRow({ crmClientId: "crm-1", crmLinkVia: "created" })),
    });
    const failing = { findName: vi.fn().mockRejectedValue(new Error("CRM down")) };

    const withFailing = buildApp(deps(store, { customerNames: failing }));
    const r1 = await get(withFailing, `/conversations/${CONV_ID}`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().customer).toEqual({ linkVia: "created", name: null });
    await withFailing.close();

    const withoutCrm = buildApp(deps(store));
    expect((await get(withoutCrm, `/conversations/${CONV_ID}`)).json().customer).toEqual({ linkVia: "created", name: null });
    await withoutCrm.close();
  });

  it("no CRM link → linkVia null", async () => {
    const store = fakeDashboardStore({ getInboxRow: vi.fn().mockResolvedValue(inboxRow()) });
    const app = buildApp(deps(store));
    expect((await get(app, `/conversations/${CONV_ID}`)).json().customer).toEqual({ linkVia: null });
    await app.close();
  });
});

describe("assign / unassign", () => {
  it("assigns to the caller", async () => {
    const store = fakeDashboardStore({ displayNames: vi.fn().mockResolvedValue(new Map([[TEST_USER.id, "Rafael"]])) });
    const app = buildApp(deps(store));
    const response = await post(app, `/conversations/${CONV_ID}/assign`);
    expect(response.statusCode).toBe(200);
    expect(store.assign).toHaveBeenCalledWith(CONV_ID, TEST_USER.id);
    expect(response.json()).toEqual({ assignedTo: { id: TEST_USER.id, displayName: "Rafael" } });
    await app.close();
  });

  it("409 when not awaiting a human, 404 when missing or malformed", async () => {
    const notAwaiting = buildApp(deps(fakeDashboardStore({ assign: vi.fn().mockResolvedValue("not-awaiting") })));
    expect((await post(notAwaiting, `/conversations/${CONV_ID}/assign`)).statusCode).toBe(409);
    await notAwaiting.close();

    const missing = buildApp(deps(fakeDashboardStore({ assign: vi.fn().mockResolvedValue("not-found") })));
    expect((await post(missing, `/conversations/${CONV_ID}/assign`)).statusCode).toBe(404);
    expect((await post(missing, "/conversations/nope/assign")).statusCode).toBe(404);
    await missing.close();
  });

  it("unassigns; 404 when missing", async () => {
    const ok = buildApp(deps(fakeDashboardStore()));
    const response = await post(ok, `/conversations/${CONV_ID}/unassign`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assignedTo: null });
    await ok.close();

    const missing = buildApp(deps(fakeDashboardStore({ unassign: vi.fn().mockResolvedValue(false) })));
    expect((await post(missing, `/conversations/${CONV_ID}/unassign`)).statusCode).toBe(404);
    await missing.close();
  });
});
```

In `apps/api/tests/conversations.test.ts`, add inside `describe("POST /conversations/:id/messages", ...)`:

```ts
  it("records the caller as the sender", async () => {
    sendMock.mockResolvedValue({ id: "m1", conversationId: "c1", direction: "out", content: "hi", createdAt: "x" });
    const app = buildApp(baseDeps());
    await send(app, { text: "hi" });
    expect(sendMock).toHaveBeenCalledWith(expect.anything(), { conversationId: "c1", text: "hi", sentBy: "test-user" });
    await app.close();
  });

  it("400 for whitespace-only or over-4096-character text", async () => {
    const app = buildApp(baseDeps());
    expect((await send(app, { text: "   " })).statusCode).toBe(400);
    expect((await send(app, { text: "a".repeat(4097) })).statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run tests/inbox.test.ts tests/conversations.test.ts`
Expected: FAIL — routes 404 / `sentBy` missing / 4097 accepted.

- [ ] **Step 3: Implement**

`apps/api/src/dashboard/present.ts`:

```ts
import type { FastifyBaseLogger } from "fastify";
import type { CustomerNamePort } from "./customerNames";
import type { InboxRow, MessageRow } from "./store";

export const PREVIEW_LENGTH = 140;

export type Person = { id: string; displayName: string };
export type CustomerView =
  | { linkVia: null }
  | { linkVia: "phone" | "created"; name: string | null }
  | { linkVia: "cpf"; unverified: true };

function person(id: string | null, names: Map<string, string>): Person | null {
  return id ? { id, displayName: names.get(id) ?? id } : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function toListItem(row: InboxRow, names: Map<string, string>) {
  return {
    id: row.id,
    contactPhone: row.contactPhone,
    instance: row.instance,
    status: row.status,
    handoffSummary: row.handoffSummary,
    handoffAt: row.handoffAt,
    assignedTo: person(row.assignedTo, names),
    lastMessage: row.lastMessage
      ? { ...row.lastMessage, content: truncate(row.lastMessage.content, PREVIEW_LENGTH) }
      : null,
    awaitingReply: row.lastMessage?.direction === "in",
    crmLinkVia: row.crmLinkVia,
  };
}

export function toMessage(message: MessageRow, names: Map<string, string>) {
  return {
    id: message.id,
    direction: message.direction,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    sentBy: person(message.sentBy, names),
  };
}

/**
 * A CPF link never reveals the stored client: whoever typed the CPF may not
 * own it. CRM trouble degrades to "name unavailable", never to an error.
 */
export async function resolveCustomer(
  row: InboxRow,
  port: CustomerNamePort | undefined,
  log: FastifyBaseLogger,
): Promise<CustomerView> {
  if (!row.crmLinkVia || !row.crmClientId) return { linkVia: null };
  if (row.crmLinkVia === "cpf") return { linkVia: "cpf", unverified: true };
  if (!port) return { linkVia: row.crmLinkVia, name: null };
  try {
    return { linkVia: row.crmLinkVia, name: await port.findName(row.crmClientId) };
  } catch (error) {
    log.warn({ err: error }, "CRM name lookup failed");
    return { linkVia: row.crmLinkVia, name: null };
  }
}
```

`apps/api/src/routes/inbox.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { dashboardStore, type AppDependencies } from "../app";
import { isUuid } from "../dashboard/uuid";
import type { InboxView } from "../dashboard/store";
import { resolveCustomer, toListItem, toMessage } from "../dashboard/present";

const VIEWS: readonly InboxView[] = ["handoff", "all", "mine"];
const DETAIL_MESSAGE_LIMIT = 100;

export function registerInboxRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get("/conversations", async (request, reply) => {
    const { view = "handoff" } = request.query as { view?: string };
    if (!VIEWS.includes(view as InboxView)) return reply.code(400).send({ error: "invalid view" });

    const store = dashboardStore(deps);
    const me = request.user!.id;
    const [rows, counts] = await Promise.all([store.listInbox(view as InboxView, me), store.countInbox(me)]);
    const names = await store.displayNames(rows.flatMap((row) => (row.assignedTo ? [row.assignedTo] : [])));
    return { items: rows.map((row) => toListItem(row, names)), counts };
  });

  app.get("/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "conversation not found" });

    const store = dashboardStore(deps);
    const row = await store.getInboxRow(id);
    if (!row) return reply.code(404).send({ error: "conversation not found" });

    const [messages, customer] = await Promise.all([
      store.listMessages(id, DETAIL_MESSAGE_LIMIT),
      resolveCustomer(row, deps.customerNames, request.log),
    ]);
    const people = [row.assignedTo, ...messages.map((m) => m.sentBy)].filter((v): v is string => Boolean(v));
    const names = await store.displayNames(people);

    return { ...toListItem(row, names), messages: messages.map((m) => toMessage(m, names)), customer };
  });

  app.post("/conversations/:id/assign", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "conversation not found" });

    const store = dashboardStore(deps);
    const user = request.user!;
    const outcome = await store.assign(id, user.id);
    if (outcome === "not-found") return reply.code(404).send({ error: "conversation not found" });
    if (outcome === "not-awaiting") return reply.code(409).send({ error: "conversation is not awaiting a human" });

    const names = await store.displayNames([user.id]);
    return { assignedTo: { id: user.id, displayName: names.get(user.id) ?? user.email ?? user.id } };
  });

  app.post("/conversations/:id/unassign", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "conversation not found" });
    const ok = await dashboardStore(deps).unassign(id);
    if (!ok) return reply.code(404).send({ error: "conversation not found" });
    return { assignedTo: null };
  });
}
```

In `apps/api/src/routes/conversations.ts`, replace the text parsing and send call of `POST /conversations/:id/messages`:

```ts
const MAX_REPLY_LENGTH = 4096;
```

(at module top, below the imports) and inside the handler:

```ts
    const text = body && typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "text is required" });
    if (text.length > MAX_REPLY_LENGTH) return reply.code(400).send({ error: "text is too long" });

    try {
      const sent = await sendMessage(deps, { conversationId: id, text, sentBy: request.user!.id });
```

In `apps/api/src/app.ts`, import `registerInboxRoutes` from `./routes/inbox` and call `registerInboxRoutes(scope, deps);` in the authenticated block.

- [ ] **Step 4: Run API tests and type-check**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/tests/inbox.test.ts apps/api/tests/conversations.test.ts
git commit -m "feat(api): inbox list, conversation detail, assign/unassign, reply author"
```

---

### Task 6: Agent routes

**Files:**
- Create: `apps/api/src/routes/agents.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/tests/agents.test.ts`

**Interfaces:**
- Consumes: `dashboardStore(deps)`, `deps.config.providers` (Task 4); `pickAgent`, `AgentRow`, `AgentInput`, `isUuid` (Task 3).
- Produces:
  - `AgentDto = { id, instanceId, name, provider, model, systemPrompt, handoffMessage, isActive }`
  - `GET /agents` → `Array<{ instance: {id, name, status}, agent: AgentDto | null }>`
  - `POST /agents` body `{ instanceId, name, provider, model, systemPrompt, handoffMessage?, isActive }` → 201 `{ agent: AgentDto, warning?: "provider-key-missing" }`; 400 invalid; 404 instance missing; 409 instance already has an agent
  - `PUT /agents/:id` body `{ name, provider, model, systemPrompt, handoffMessage, isActive }` → 200 `{ agent, warning? }`; 400; 404

- [ ] **Step 1: Write the failing tests**

`apps/api/tests/agents.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, testAuth } from "./helpers/auth";
import { AGENT_ID, INSTANCE_ID, agentRow, fakeDashboardStore } from "./helpers/fakeDashboardStore";
import type { DashboardStore } from "../src/dashboard/store";

function deps(store: DashboardStore, providers = { anthropic: true, openai: true }): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: testAuth(),
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com", allowedUsers: TEST_ALLOWED_USERS, providers },
    dashboard: store,
  };
}

const VALID = {
  name: "Atendente",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  systemPrompt: "Você atende a Loja Exemplo.",
  handoffMessage: "Já te passo para alguém.",
  isActive: true,
};

describe("GET /agents", () => {
  it("401 without a token", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    expect((await app.inject({ method: "GET", url: "/agents" })).statusCode).toBe(401);
    await app.close();
  });

  it("one row per instance with the picked agent or null", async () => {
    const store = fakeDashboardStore({
      listInstancesWithAgents: vi.fn().mockResolvedValue([
        { id: INSTANCE_ID, name: "loja", status: "connected", agents: [agentRow({ isActive: false, createdAt: "1" }), agentRow({ id: "a2", createdAt: "2" })] },
        { id: "i2", name: "outra", status: "created", agents: [] },
      ]),
    });
    const app = buildApp(deps(store));

    const body = (await app.inject({ method: "GET", url: "/agents", headers: AUTH_HEADERS })).json();

    expect(body).toHaveLength(2);
    expect(body[0].instance).toEqual({ id: INSTANCE_ID, name: "loja", status: "connected" });
    expect(body[0].agent.id).toBe("a2");
    expect(body[0].agent).not.toHaveProperty("createdAt");
    expect(body[1].agent).toBeNull();
    await app.close();
  });
});

describe("POST /agents", () => {
  const create = (app: ReturnType<typeof buildApp>, payload: object) =>
    app.inject({ method: "POST", url: "/agents", payload, headers: AUTH_HEADERS });

  it("201 creates the agent for an instance without one", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    const response = await create(app, { instanceId: INSTANCE_ID, ...VALID });
    expect(response.statusCode).toBe(201);
    expect(store.createAgent).toHaveBeenCalledWith(INSTANCE_ID, VALID);
    expect(response.json().agent.id).toBe(AGENT_ID);
    expect(response.json()).not.toHaveProperty("warning");
    await app.close();
  });

  it("handoffMessage is optional on create", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    const { handoffMessage: _omit, ...rest } = VALID;
    expect((await create(app, { instanceId: INSTANCE_ID, ...rest })).statusCode).toBe(201);
    expect(store.createAgent).toHaveBeenCalledWith(INSTANCE_ID, rest);
    await app.close();
  });

  it("409 when the instance already has an agent; 404 when the instance is missing", async () => {
    const taken = buildApp(deps(fakeDashboardStore({ countAgents: vi.fn().mockResolvedValue(1) })));
    expect((await create(taken, { instanceId: INSTANCE_ID, ...VALID })).statusCode).toBe(409);
    await taken.close();

    const missing = buildApp(deps(fakeDashboardStore({ instanceExists: vi.fn().mockResolvedValue(false) })));
    expect((await create(missing, { instanceId: INSTANCE_ID, ...VALID })).statusCode).toBe(404);
    await missing.close();
  });

  it("400 on invalid input", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    for (const bad of [
      { instanceId: "nope", ...VALID },
      { instanceId: INSTANCE_ID, ...VALID, provider: "gemini" },
      { instanceId: INSTANCE_ID, ...VALID, name: "   " },
      { instanceId: INSTANCE_ID, ...VALID, model: "" },
      { instanceId: INSTANCE_ID, ...VALID, systemPrompt: "a".repeat(20001) },
      { instanceId: INSTANCE_ID, ...VALID, handoffMessage: "a".repeat(1001) },
      { instanceId: INSTANCE_ID, ...VALID, isActive: "yes" },
    ]) {
      expect((await create(app, bad)).statusCode).toBe(400);
    }
    expect(store.createAgent).not.toHaveBeenCalled();
    await app.close();
  });

  it("warns when the provider has no key configured", async () => {
    const app = buildApp(deps(fakeDashboardStore(), { anthropic: false, openai: true }));
    const response = await create(app, { instanceId: INSTANCE_ID, ...VALID });
    expect(response.statusCode).toBe(201);
    expect(response.json().warning).toBe("provider-key-missing");
    await app.close();
  });
});

describe("PUT /agents/:id", () => {
  const put = (app: ReturnType<typeof buildApp>, id: string, payload: object) =>
    app.inject({ method: "PUT", url: `/agents/${id}`, payload, headers: AUTH_HEADERS });

  it("200 updates and returns the agent", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    const response = await put(app, AGENT_ID, VALID);
    expect(response.statusCode).toBe(200);
    expect(store.updateAgent).toHaveBeenCalledWith(AGENT_ID, VALID);
    await app.close();
  });

  it("404 for a malformed or unknown id", async () => {
    const store = fakeDashboardStore({ updateAgent: vi.fn().mockResolvedValue(null) });
    const app = buildApp(deps(store));
    expect((await put(app, "abc", VALID)).statusCode).toBe(404);
    expect((await put(app, AGENT_ID, VALID)).statusCode).toBe(404);
    await app.close();
  });

  it("400 when handoffMessage is missing (full replace)", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    const { handoffMessage: _omit, ...rest } = VALID;
    expect((await put(app, AGENT_ID, rest)).statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run tests/agents.test.ts`
Expected: FAIL — 404 on `/agents`.

- [ ] **Step 3: Implement**

`apps/api/src/routes/agents.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dashboardStore, type AppDependencies } from "../app";
import { pickAgent, type AgentInput, type AgentRow } from "../dashboard/store";
import { isUuid } from "../dashboard/uuid";

const agentFields = {
  name: z.string().trim().min(1).max(100),
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().trim().min(1).max(100),
  systemPrompt: z.string().max(20000),
  isActive: z.boolean(),
};
const handoffMessage = z.string().trim().min(1).max(1000);

const createSchema = z.object({
  instanceId: z.string().refine(isUuid),
  ...agentFields,
  handoffMessage: handoffMessage.optional(),
});
const updateSchema = z.object({ ...agentFields, handoffMessage });

function toDto(agent: AgentRow) {
  return {
    id: agent.id,
    instanceId: agent.instanceId,
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    handoffMessage: agent.handoffMessage,
    isActive: agent.isActive,
  };
}

function providerWarning(deps: AppDependencies, provider: AgentInput["provider"]) {
  const available = deps.config.providers?.[provider] ?? false;
  return available ? {} : { warning: "provider-key-missing" as const };
}

export function registerAgentRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get("/agents", async () => {
    const instances = await dashboardStore(deps).listInstancesWithAgents();
    return instances.map((instance) => {
      const agent = pickAgent(instance.agents);
      return {
        instance: { id: instance.id, name: instance.name, status: instance.status },
        agent: agent ? toDto(agent) : null,
      };
    });
  });

  app.post("/agents", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid agent", issues: parsed.error.issues });

    const { instanceId, ...input } = parsed.data;
    const store = dashboardStore(deps);
    if (!(await store.instanceExists(instanceId))) return reply.code(404).send({ error: "instance not found" });
    if ((await store.countAgents(instanceId)) > 0) {
      return reply.code(409).send({ error: "instance already has an agent" });
    }

    const agent = await store.createAgent(instanceId, input);
    return reply.code(201).send({ agent: toDto(agent), ...providerWarning(deps, input.provider) });
  });

  app.put("/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "agent not found" });

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid agent", issues: parsed.error.issues });

    const agent = await dashboardStore(deps).updateAgent(id, parsed.data);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    return { agent: toDto(agent), ...providerWarning(deps, parsed.data.provider) };
  });
}
```

Note: zod strips unknown keys, so `createAgent` receives exactly the parsed fields (the test asserts `VALID`/`rest` equality — zod's `.trim()` leaves already-trimmed values unchanged).

In `apps/api/src/app.ts`, import `registerAgentRoutes` from `./routes/agents` and call `registerAgentRoutes(scope, deps);` in the authenticated block.

- [ ] **Step 4: Run API tests and type-check**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents.ts apps/api/src/app.ts apps/api/tests/agents.test.ts
git commit -m "feat(api): agent list, create and update routes"
```

---

### Task 7: Dashboard foundation (proxy, API client, polling, formatting, shell)

**Files:**
- Modify: `apps/dashboard/next.config.js`, `apps/dashboard/app/layout.tsx`, `apps/dashboard/app/login/page.tsx`, `apps/dashboard/app/dashboard/page.tsx`, `apps/dashboard/.env.example`
- Create: `apps/dashboard/lib/api.ts`, `lib/browserApi.ts`, `lib/usePolling.ts`, `lib/useMe.ts`, `lib/format.ts`, `lib/replyGate.ts`, `lib/types.ts`
- Create: `apps/dashboard/app/globals.css`, `app/dashboard/layout.tsx`, `app/dashboard/DashboardShell.tsx`, `app/dashboard/ui.module.css`
- Test: `apps/dashboard/tests/api.test.ts`, `tests/format.test.ts`, `tests/replyGate.test.ts`

**Interfaces:**
- Consumes: API shapes from Tasks 4–6.
- Produces (pages in Tasks 8–10 use these exact names):
  - `createApiFetch(deps: { getToken(): Promise<string | null>; onUnauthorized(): void; fetchImpl?: typeof fetch })` → `apiFetch<T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>`; `class ApiError extends Error { status: number; body: unknown }`
  - `apiFetch` (browser instance) from `lib/browserApi.ts`
  - `usePolling<T>(load: () => Promise<T>, key: string, intervalMs?: number)` → `{ data: T | null; error: unknown; refresh(): Promise<void> }`
  - `useMe()` → `Me | null`
  - `formatPhone(digits: string): string`, `formatTime(iso: string): string`, `formatRelative(iso: string, now?: Date): string`
  - `replyGate(conversation: { status: string; assignedTo: { id: string } | null }, meId: string): "read-only" | "assume-first" | "warn-other-owner" | "ok"`
  - types in `lib/types.ts`: `Me`, `Person`, `ConversationListItem`, `InboxResponse`, `ConversationDetail`, `ChatMessage`, `CustomerView`, `AgentDto`, `AgentListRow`, `InstanceRow`, `QrResponse`
  - CSS module `app/dashboard/ui.module.css` class names listed in Step 6.

- [ ] **Step 1: Write the failing tests**

`apps/dashboard/tests/api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiFetch } from "../lib/api";

function response(status: number, body: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

describe("createApiFetch", () => {
  it("sends the bearer token to /api and parses JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { ok: 1 }));
    const apiFetch = createApiFetch({ getToken: async () => "tok", onUnauthorized: vi.fn(), fetchImpl });

    await expect(apiFetch("/me")).resolves.toEqual({ ok: 1 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/me");
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(init.body).toBeUndefined();
  });

  it("serialises a JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(201, { id: "m1" }));
    const apiFetch = createApiFetch({ getToken: async () => "tok", onUnauthorized: vi.fn(), fetchImpl });
    await apiFetch("/conversations/c1/messages", { method: "POST", body: { text: "oi" } });
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ text: "oi" }));
  });

  it("calls onUnauthorized on 401 and when there is no session", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(response(401, { error: "unauthorized" }));
    const withToken = createApiFetch({ getToken: async () => "tok", onUnauthorized, fetchImpl });
    await expect(withToken("/me")).rejects.toMatchObject({ status: 401 });

    const noToken = createApiFetch({ getToken: async () => null, onUnauthorized, fetchImpl });
    await expect(noToken("/me")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws ApiError with status and body on other failures; empty 204 resolves null", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(409, { error: "taken" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const apiFetch = createApiFetch({ getToken: async () => "tok", onUnauthorized: vi.fn(), fetchImpl });
    await expect(apiFetch("/agents", { method: "POST", body: {} })).rejects.toMatchObject({ status: 409, body: { error: "taken" } });
    await expect(apiFetch("/instances/x", { method: "DELETE" })).resolves.toBeNull();
  });
});
```

`apps/dashboard/tests/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatPhone, formatRelative } from "../lib/format";

describe("formatPhone", () => {
  it("formats Brazilian mobile and landline numbers with country code", () => {
    expect(formatPhone("5511900000002")).toBe("+55 (11) 90000-0002");
    expect(formatPhone("551133334444")).toBe("+55 (11) 3333-4444");
  });
  it("leaves anything else as digits", () => {
    expect(formatPhone("12025550123")).toBe("12025550123");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("buckets elapsed time", () => {
    expect(formatRelative("2026-10-15T11:59:40Z", now)).toBe("agora");
    expect(formatRelative("2026-10-15T11:55:00Z", now)).toBe("5 min");
    expect(formatRelative("2026-10-15T09:00:00Z", now)).toBe("3 h");
    expect(formatRelative("2026-10-13T12:00:00Z", now)).toBe("2 d");
  });
  it("treats future timestamps (clock skew) as now", () => {
    expect(formatRelative("2026-10-15T12:00:30Z", now)).toBe("agora");
  });
});
```

`apps/dashboard/tests/replyGate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { replyGate } from "../lib/replyGate";

describe("replyGate", () => {
  it("open conversations are read-only", () => {
    expect(replyGate({ status: "open", assignedTo: null }, "me")).toBe("read-only");
  });
  it("unassigned handoff asks to assume first", () => {
    expect(replyGate({ status: "awaiting_human", assignedTo: null }, "me")).toBe("assume-first");
  });
  it("someone else's handoff warns", () => {
    expect(replyGate({ status: "awaiting_human", assignedTo: { id: "other" } }, "me")).toBe("warn-other-owner");
  });
  it("my handoff is ok", () => {
    expect(replyGate({ status: "awaiting_human", assignedTo: { id: "me" } }, "me")).toBe("ok");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/dashboard && npx vitest run`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the pure libraries**

`apps/dashboard/lib/api.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API request failed with status ${status}`);
    this.name = "ApiError";
  }
}

export interface ApiFetchDeps {
  getToken(): Promise<string | null>;
  onUnauthorized(): void;
  fetchImpl?: typeof fetch;
}

function parse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Calls the API through the same-origin `/api` proxy with the user's token. */
export function createApiFetch(deps: ApiFetchDeps) {
  return async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await deps.getToken();
    if (!token) {
      deps.onUnauthorized();
      throw new ApiError(401, null);
    }

    const hasBody = init.body !== undefined;
    const response = await (deps.fetchImpl ?? fetch)(`/api${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(hasBody && { "content-type": "application/json" }) },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const body = parse(await response.text());

    if (response.status === 401) {
      deps.onUnauthorized();
      throw new ApiError(401, body);
    }
    if (!response.ok) throw new ApiError(response.status, body);
    return body as T;
  };
}
```

`apps/dashboard/lib/format.ts`:

```ts
/** "5511900000002" → "+55 (11) 90000-0002"; non-Brazilian numbers stay as digits. */
export function formatPhone(digits: string): string {
  const match = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return match ? `+55 (${match[1]}) ${match[2]}-${match[3]}` : digits;
}

const timeFormat = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Sao_Paulo",
});

export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "agora";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}
```

`apps/dashboard/lib/replyGate.ts`:

```ts
export type ReplyGate = "read-only" | "assume-first" | "warn-other-owner" | "ok";

/** Advisory assignment: only handoffs take replies; others get a confirmation first. */
export function replyGate(
  conversation: { status: string; assignedTo: { id: string } | null },
  meId: string,
): ReplyGate {
  if (conversation.status !== "awaiting_human") return "read-only";
  if (!conversation.assignedTo) return "assume-first";
  return conversation.assignedTo.id === meId ? "ok" : "warn-other-owner";
}
```

`apps/dashboard/lib/types.ts`:

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `cd apps/dashboard && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Implement the browser glue (no unit tests: thin React/Supabase wrappers)**

`apps/dashboard/lib/browserApi.ts`:

```ts
"use client";

import { createClient } from "./supabase/client";
import { createApiFetch } from "./api";

export const apiFetch = createApiFetch({
  async getToken() {
    const { data } = await createClient().auth.getSession();
    return data.session?.access_token ?? null;
  },
  onUnauthorized() {
    void createClient().auth.signOut();
    if (typeof window !== "undefined") window.location.href = "/login";
  },
});
```

`apps/dashboard/lib/usePolling.ts`:

```ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const POLL_INTERVAL_MS = 10_000;

/**
 * Loads now, then every `intervalMs` while the tab is visible, and again when
 * it becomes visible. `key` restarts the cycle (e.g. a different tab or id).
 */
export function usePolling<T>(load: () => Promise<T>, key: string, intervalMs = POLL_INTERVAL_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    setData(null);
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, intervalMs, refresh]);

  return { data, error, refresh };
}
```

`apps/dashboard/lib/useMe.ts`:

```ts
"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./browserApi";
import type { Me } from "./types";

let pending: Promise<Me> | null = null;

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    pending ??= apiFetch<Me>("/me");
    pending.then(setMe).catch(() => {
      pending = null;
    });
  }, []);
  return me;
}
```

- [ ] **Step 6: Proxy, global styles, shell**

`apps/dashboard/next.config.js`:

```js
/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig = {
  // The browser calls /api/* on the dashboard's own origin; Next forwards to
  // the API, so the API needs no CORS and its URL never matters to the client.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};

module.exports = nextConfig;
```

Append to `apps/dashboard/.env.example`:

```
# Server-side target of the /api proxy (defaults to NEXT_PUBLIC_API_URL)
API_URL=http://localhost:3001
```

`apps/dashboard/app/globals.css`:

```css
:root {
  --bg: #f5f7fa;
  --surface: #ffffff;
  --border: #dde3ea;
  --text: #1c2733;
  --muted: #637282;
  --accent: #0b6e99;
  --accent-text: #ffffff;
  --warn-bg: #fff4d6;
  --warn-text: #7a5300;
  --danger: #b42318;
  --mine: #e6f4fa;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
button, input, select, textarea { font: inherit; }
```

In `apps/dashboard/app/layout.tsx` add `import "./globals.css";` as the first line.

`apps/dashboard/app/dashboard/ui.module.css` (all pages share these class names):

```css
.shell { display: grid; grid-template-columns: 200px 1fr; min-height: 100vh; }
.nav { background: var(--surface); border-right: 1px solid var(--border); padding: 16px 12px; display: flex; flex-direction: column; gap: 4px; }
.brand { font-weight: 700; margin: 0 8px 16px; }
.navLink { display: flex; justify-content: space-between; padding: 8px; border-radius: 6px; color: var(--text); text-decoration: none; }
.navLink:hover { background: var(--bg); }
.navActive { background: var(--mine); font-weight: 600; }
.badge { background: var(--accent); color: var(--accent-text); border-radius: 999px; padding: 0 8px; font-size: 12px; }
.navFooter { margin-top: auto; padding: 8px; color: var(--muted); display: flex; flex-direction: column; gap: 8px; }
.main { padding: 20px; min-width: 0; }
.button { background: var(--accent); color: var(--accent-text); border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
.button:disabled { opacity: 0.5; cursor: default; }
.secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 14px; cursor: pointer; }
.danger { background: var(--danger); color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
.warn { background: var(--warn-bg); color: var(--warn-text); border-radius: 6px; padding: 8px 12px; }
.error { color: var(--danger); }
.muted { color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.tab { composes: secondary; }
.tabActive { composes: button; }
.inbox { display: grid; grid-template-columns: 340px 1fr; gap: 16px; height: calc(100vh - 100px); }
.list { overflow-y: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.item { display: block; width: 100%; text-align: left; padding: 12px; border: 0; border-bottom: 1px solid var(--border); background: none; cursor: pointer; color: inherit; }
.itemSelected { background: var(--mine); }
.itemTitle { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
.itemPreview { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.awaiting { color: var(--accent); font-weight: 600; font-size: 12px; }
.pane { display: flex; flex-direction: column; gap: 12px; min-height: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.history { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.bubble { max-width: 75%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
.fromCustomer { align-self: flex-start; background: var(--bg); }
.fromBot { align-self: flex-end; background: #e9eef3; }
.fromHuman { align-self: flex-end; background: var(--mine); }
.bubbleMeta { font-size: 11px; color: var(--muted); margin-top: 2px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.input, .textarea, .select { border: 1px solid var(--border); border-radius: 6px; padding: 8px; background: #fff; width: 100%; }
.textarea { min-height: 80px; resize: vertical; }
.tall { min-height: 320px; }
.table { width: 100%; border-collapse: collapse; background: var(--surface); }
.table th, .table td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border); }
.backLink { display: none; }
.qr { width: 260px; height: 260px; }

@media (max-width: 768px) {
  .shell { grid-template-columns: 1fr; }
  .nav { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .brand, .navFooter { display: none; }
  .main { padding: 12px; }
  .inbox { grid-template-columns: 1fr; height: auto; }
  .inboxHasSelection .list { display: none; }
  .inboxNoSelection .pane { display: none; }
  .backLink { display: inline-block; }
}
```

`apps/dashboard/app/dashboard/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { DashboardShell } from "./DashboardShell";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
```

`apps/dashboard/app/dashboard/DashboardShell.tsx`:

```tsx
"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiFetch } from "../../lib/browserApi";
import { createClient } from "../../lib/supabase/client";
import { usePolling } from "../../lib/usePolling";
import { useMe } from "../../lib/useMe";
import type { InboxResponse } from "../../lib/types";
import ui from "./ui.module.css";

const LINKS = [
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard/agents", label: "Agentes" },
  { href: "/dashboard/instances", label: "Números" },
  { href: "/dashboard", label: "Status" },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const me = useMe();
  const { data } = usePolling(() => apiFetch<InboxResponse>("/conversations?view=handoff"), "shell-counts");
  const handoffs = data?.counts.handoff ?? 0;

  useEffect(() => {
    document.title = handoffs > 0 ? `(${handoffs}) fmagentes` : "fmagentes";
  }, [handoffs]);

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const isActive = (href: string) => (href === "/dashboard" ? pathname === href : pathname.startsWith(href));

  return (
    <div className={ui.shell}>
      <nav className={ui.nav}>
        <div className={ui.brand}>fmagentes</div>
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={`${ui.navLink} ${isActive(link.href) ? ui.navActive : ""}`}>
            <span>{link.label}</span>
            {link.href === "/dashboard/inbox" && handoffs > 0 ? <span className={ui.badge}>{handoffs}</span> : null}
          </Link>
        ))}
        <div className={ui.navFooter}>
          <span>{me?.displayName ?? ""}</span>
          <button type="button" className={ui.secondary} onClick={signOut}>
            Sair
          </button>
        </div>
      </nav>
      <main className={ui.main}>{children}</main>
    </div>
  );
}
```

In `apps/dashboard/app/login/page.tsx`, change `router.push("/dashboard");` to `router.push("/dashboard/inbox");`.

In `apps/dashboard/app/dashboard/page.tsx`, change the heading text `Status do sistema` → keep it, and nothing else (it now renders inside the shell).

- [ ] **Step 7: Build and test**

Run: `cd apps/dashboard && npx vitest run && npx next build`
Expected: tests PASS; build succeeds (routes `/dashboard`, `/login`). If `next build` complains that `.tab`/`.tabActive` `composes` is unsupported, replace them with duplicated declarations of `.secondary`/`.button`.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard
git commit -m "feat(dashboard): API proxy, client, polling, formatting and navigation shell"
```

---

### Task 8: Inbox page

**Files:**
- Create: `apps/dashboard/app/dashboard/inbox/page.tsx`
- Create: `apps/dashboard/app/dashboard/inbox/ConversationList.tsx`
- Create: `apps/dashboard/app/dashboard/inbox/ConversationPane.tsx`

**Interfaces:**
- Consumes (exact): `apiFetch`, `usePolling`, `useMe`, `replyGate`, `formatPhone`, `formatTime`, `formatRelative`, types `InboxResponse`, `ConversationListItem`, `ConversationDetail`, `ChatMessage`, `Me`, CSS module `../ui.module.css` (Task 7); routes `GET /conversations?view=`, `GET /conversations/:id`, `POST /conversations/:id/{assign,unassign,messages,resume}` (Tasks 4–5 + existing).

- [ ] **Step 1: Write `page.tsx`**

```tsx
"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "../../../lib/browserApi";
import { usePolling } from "../../../lib/usePolling";
import { useMe } from "../../../lib/useMe";
import type { InboxResponse } from "../../../lib/types";
import { ConversationList } from "./ConversationList";
import { ConversationPane } from "./ConversationPane";
import ui from "../ui.module.css";

type Tab = "handoff" | "mine" | "all";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "handoff", label: "Transferidas" },
  { id: "mine", label: "Minhas" },
  { id: "all", label: "Todas" },
];

function Inbox() {
  const params = useSearchParams();
  const router = useRouter();
  const me = useMe();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "handoff") as Tab;
  const selected = params.get("c");
  const list = usePolling(() => apiFetch<InboxResponse>(`/conversations?view=${tab}`), `inbox-${tab}`);

  function navigate(next: { tab?: Tab; c?: string | null }) {
    const query = new URLSearchParams(params.toString());
    if (next.tab) {
      query.set("tab", next.tab);
      query.delete("c");
    }
    if (next.c !== undefined) {
      if (next.c) query.set("c", next.c);
      else query.delete("c");
    }
    router.replace(`/dashboard/inbox?${query.toString()}`);
  }

  const counts = list.data?.counts;
  const countFor = (id: Tab) => (id === "handoff" ? counts?.handoff : id === "mine" ? counts?.mine : undefined);

  return (
    <div>
      <div className={ui.tabs}>
        {TABS.map((t) => (
          <button key={t.id} type="button" className={t.id === tab ? ui.tabActive : ui.tab} onClick={() => navigate({ tab: t.id })}>
            {t.label}
            {countFor(t.id) ? ` (${countFor(t.id)})` : ""}
          </button>
        ))}
      </div>
      <div className={`${ui.inbox} ${selected ? ui.inboxHasSelection : ui.inboxNoSelection}`}>
        <ConversationList
          items={list.data?.items ?? null}
          error={list.error}
          selectedId={selected}
          emptyText={tab === "all" ? "Nenhuma conversa aberta." : "Nenhuma conversa aguardando atendente."}
          onSelect={(id) => navigate({ c: id })}
        />
        <div className={ui.pane}>
          {selected && me ? (
            <ConversationPane
              key={selected}
              id={selected}
              me={me}
              onBack={() => navigate({ c: null })}
              onChanged={() => void list.refresh()}
            />
          ) : (
            <p className={ui.muted}>Selecione uma conversa.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={<p>Carregando…</p>}>
      <Inbox />
    </Suspense>
  );
}
```

- [ ] **Step 2: Write `ConversationList.tsx`**

```tsx
"use client";

import { formatPhone, formatRelative } from "../../../lib/format";
import type { ConversationListItem } from "../../../lib/types";
import ui from "../ui.module.css";

export function ConversationList(props: {
  items: ConversationListItem[] | null;
  error: unknown;
  selectedId: string | null;
  emptyText: string;
  onSelect(id: string): void;
}) {
  if (props.items === null) {
    return <div className={ui.list}>{props.error ? <p className={ui.error}>Erro ao carregar.</p> : <p className={ui.muted}>Carregando…</p>}</div>;
  }
  return (
    <div className={ui.list}>
      {props.error ? <p className={ui.error}>Sem conexão com a API — mostrando a última lista.</p> : null}
      {props.items.length === 0 ? <p className={ui.muted} style={{ padding: 12 }}>{props.emptyText}</p> : null}
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`${ui.item} ${item.id === props.selectedId ? ui.itemSelected : ""}`}
          onClick={() => props.onSelect(item.id)}
        >
          <div className={ui.itemTitle}>
            <span>{formatPhone(item.contactPhone)}</span>
            <span className={ui.muted}>{item.lastMessage ? formatRelative(item.lastMessage.createdAt) : ""}</span>
          </div>
          {item.handoffSummary ? <div className={ui.itemPreview}>{item.handoffSummary}</div> : null}
          <div className={ui.itemPreview}>{item.lastMessage?.content ?? "—"}</div>
          <div className={ui.row}>
            {item.awaitingReply && item.status === "awaiting_human" ? <span className={ui.awaiting}>aguardando resposta</span> : null}
            {item.assignedTo ? <span className={ui.muted}>{item.assignedTo.displayName}</span> : null}
            <span className={ui.muted}>{item.instance.name}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write `ConversationPane.tsx`**

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "../../../lib/browserApi";
import { ApiError } from "../../../lib/api";
import { formatPhone, formatTime } from "../../../lib/format";
import { replyGate } from "../../../lib/replyGate";
import { usePolling } from "../../../lib/usePolling";
import type { ChatMessage, ConversationDetail, Me } from "../../../lib/types";
import ui from "../ui.module.css";

type Confirm = { text: string; action: () => Promise<void> } | null;

function bubbleClass(message: ChatMessage): string {
  if (message.direction === "in") return ui.fromCustomer;
  return message.sentBy ? ui.fromHuman : ui.fromBot;
}

function author(message: ChatMessage): string {
  if (message.direction === "in") return "Cliente";
  return message.sentBy ? message.sentBy.displayName : "Bot";
}

export function ConversationPane(props: { id: string; me: Me; onBack(): void; onChanged(): void }) {
  const detail = usePolling(() => apiFetch<ConversationDetail>(`/conversations/${props.id}`), props.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const conversation = detail.data;
  if (!conversation) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return <p className={notFound ? ui.error : ui.muted}>{notFound ? "Conversa não encontrada." : "Carregando…"}</p>;
  }

  async function run(action: () => Promise<unknown>, errorText: string) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      await detail.refresh();
      props.onChanged();
    } catch {
      setFailure(errorText);
    } finally {
      setBusy(false);
    }
  }

  const assign = () => run(() => apiFetch(`/conversations/${props.id}/assign`, { method: "POST" }), "Não foi possível assumir.");
  const unassign = () => run(() => apiFetch(`/conversations/${props.id}/unassign`, { method: "POST" }), "Não foi possível soltar.");
  const resume = () =>
    run(() => apiFetch(`/conversations/${props.id}/resume`, { method: "POST" }), "Não foi possível devolver ao bot.");
  const send = () =>
    run(async () => {
      await apiFetch(`/conversations/${props.id}/messages`, { method: "POST", body: { text } });
      setText("");
    }, "Falha ao enviar. O texto foi mantido — tente de novo.");

  const gate = replyGate(conversation, props.me.id);
  const owner = conversation.assignedTo;

  function requestSend() {
    if (!text.trim()) return;
    if (gate === "assume-first") {
      setConfirm({ text: "Ninguém assumiu esta conversa. Responder sem assumir?", action: send });
    } else if (gate === "warn-other-owner") {
      setConfirm({ text: `${owner?.displayName} está atendendo. Responder mesmo assim?`, action: send });
    } else {
      void send();
    }
  }

  function requestAssign() {
    if (owner && owner.id !== props.me.id) {
      setConfirm({ text: `${owner.displayName} está atendendo. Assumir no lugar?`, action: assign });
    } else {
      void assign();
    }
  }

  const customer = conversation.customer;

  return (
    <>
      <button type="button" className={`${ui.secondary} ${ui.backLink}`} onClick={props.onBack}>
        ← Voltar
      </button>
      <div>
        <div className={ui.row}>
          <strong>
            {customer.linkVia === "phone" || customer.linkVia === "created"
              ? customer.name ?? "Cliente vinculado (nome indisponível)"
              : formatPhone(conversation.contactPhone)}
          </strong>
          <span className={ui.muted}>{formatPhone(conversation.contactPhone)} · {conversation.instance.name}</span>
        </div>
        {customer.linkVia === "cpf" ? (
          <p className={ui.warn}>CPF não verificado — o cliente digitou este CPF; confirme a identidade antes de compartilhar dados.</p>
        ) : null}
        {conversation.handoffSummary ? <p><strong>Resumo:</strong> {conversation.handoffSummary}</p> : null}
        {conversation.status === "awaiting_human" ? (
          <div className={ui.row}>
            <span>Responsável: {owner ? owner.displayName : "ninguém"}</span>
            {owner?.id === props.me.id ? (
              <button type="button" className={ui.secondary} disabled={busy} onClick={() => void unassign()}>Soltar</button>
            ) : (
              <button type="button" className={ui.button} disabled={busy} onClick={requestAssign}>Assumir</button>
            )}
            <button
              type="button"
              className={ui.secondary}
              disabled={busy}
              onClick={() => setConfirm({ text: "Devolver esta conversa ao bot? Ele volta a responder o cliente.", action: resume })}
            >
              Devolver ao bot
            </button>
          </div>
        ) : (
          <p className={ui.muted}>Conversa com o bot — somente leitura.</p>
        )}
      </div>

      <div className={ui.history}>
        {conversation.messages.map((message) => (
          <div key={message.id} className={`${ui.bubble} ${bubbleClass(message)}`}>
            {message.content}
            <div className={ui.bubbleMeta}>{author(message)} · {formatTime(message.createdAt)}</div>
          </div>
        ))}
      </div>

      {confirm ? (
        <div className={`${ui.warn} ${ui.row}`}>
          <span>{confirm.text}</span>
          <button
            type="button"
            className={ui.button}
            onClick={() => {
              const action = confirm.action;
              setConfirm(null);
              void action();
            }}
          >
            Confirmar
          </button>
          <button type="button" className={ui.secondary} onClick={() => setConfirm(null)}>Cancelar</button>
        </div>
      ) : null}
      {failure ? <p className={ui.error}>{failure}</p> : null}

      {gate !== "read-only" ? (
        <div className={ui.row}>
          <textarea
            className={ui.textarea}
            value={text}
            maxLength={4096}
            placeholder="Escreva a resposta…"
            onChange={(event) => setText(event.target.value)}
          />
          <button type="button" className={ui.button} disabled={busy || !text.trim()} onClick={requestSend}>
            {failure && text ? "Tentar de novo" : "Enviar"}
          </button>
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 4: Build**

Run: `cd apps/dashboard && npx next build && npx vitest run`
Expected: build succeeds with route `/dashboard/inbox`; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/app/dashboard/inbox
git commit -m "feat(dashboard): inbox with handoff queue, assignment, reply and resume"
```

---

### Task 9: Agents page

**Files:**
- Create: `apps/dashboard/app/dashboard/agents/page.tsx`
- Create: `apps/dashboard/app/dashboard/agents/AgentForm.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`, `usePolling`, `useMe`, types `AgentListRow`, `AgentDto`, `Me`, `../ui.module.css` (Task 7); `GET /agents`, `POST /agents`, `PUT /agents/:id` (Task 6).

- [ ] **Step 1: Write `page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "../../../lib/browserApi";
import { usePolling } from "../../../lib/usePolling";
import { useMe } from "../../../lib/useMe";
import type { AgentListRow } from "../../../lib/types";
import { AgentForm } from "./AgentForm";
import ui from "../ui.module.css";

export default function AgentsPage() {
  const me = useMe();
  const list = usePolling(() => apiFetch<AgentListRow[]>("/agents"), "agents", 60_000);
  const [selected, setSelected] = useState<string | null>(null);
  const row = list.data?.find((r) => r.instance.id === selected) ?? null;

  return (
    <div>
      <h1>Agentes</h1>
      {list.error && !list.data ? <p className={ui.error}>Erro ao carregar.</p> : null}
      <table className={ui.table}>
        <thead>
          <tr><th>Número</th><th>Agente</th><th>Modelo</th><th>Situação</th><th /></tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((r) => (
            <tr key={r.instance.id}>
              <td>{r.instance.name}</td>
              <td>{r.agent?.name ?? <span className={ui.muted}>sem agente</span>}</td>
              <td>{r.agent ? `${r.agent.provider} / ${r.agent.model}` : "—"}</td>
              <td>{r.agent ? (r.agent.isActive ? "ativo" : "desligado") : "—"}</td>
              <td>
                <button type="button" className={ui.secondary} onClick={() => setSelected(r.instance.id)}>
                  {r.agent ? "Editar" : "Criar agente"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {row && me ? (
        <div className={ui.card} style={{ marginTop: 16 }}>
          <AgentForm
            key={row.instance.id + (row.agent?.id ?? "")}
            instance={row.instance}
            agent={row.agent}
            providers={me.providers}
            onSaved={() => void list.refresh()}
            onClose={() => setSelected(null)}
          />
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Write `AgentForm.tsx`**

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "../../../lib/browserApi";
import { ApiError } from "../../../lib/api";
import type { AgentDto, Me } from "../../../lib/types";
import ui from "../ui.module.css";

const DEFAULT_HANDOFF = "Vou te passar para um atendente, já já alguém te responde.";
const MODEL_SUGGESTIONS = ["claude-haiku-4-5", "gpt-4o-mini"];

export function AgentForm(props: {
  instance: { id: string; name: string };
  agent: AgentDto | null;
  providers: Me["providers"];
  onSaved(): void;
  onClose(): void;
}) {
  const [name, setName] = useState(props.agent?.name ?? "Atendente");
  const [provider, setProvider] = useState<AgentDto["provider"]>(props.agent?.provider ?? "anthropic");
  const [model, setModel] = useState(props.agent?.model ?? "claude-haiku-4-5");
  const [systemPrompt, setSystemPrompt] = useState(props.agent?.systemPrompt ?? "");
  const [handoffMessage, setHandoffMessage] = useState(props.agent?.handoffMessage ?? DEFAULT_HANDOFF);
  const [isActive, setIsActive] = useState(props.agent?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const body = { name, provider, model, systemPrompt, handoffMessage, isActive };
    try {
      const result = props.agent
        ? await apiFetch<{ warning?: string }>(`/agents/${props.agent.id}`, { method: "PUT", body })
        : await apiFetch<{ warning?: string }>("/agents", { method: "POST", body: { instanceId: props.instance.id, ...body } });
      setStatus({
        kind: "ok",
        text: result.warning === "provider-key-missing" ? "Salvo, mas o provedor escolhido não tem chave configurada." : "Salvo.",
      });
      props.onSaved();
    } catch (error) {
      const text =
        error instanceof ApiError && error.status === 409
          ? "Este número já tem um agente."
          : error instanceof ApiError && error.status === 400
            ? "Confira os campos: nome e modelo são obrigatórios; prompt até 20.000 caracteres."
            : "Não foi possível salvar.";
      setStatus({ kind: "error", text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>{props.agent ? "Editar agente" : "Criar agente"} — {props.instance.name}</h2>
      <label className={ui.field}>
        Nome
        <input className={ui.input} value={name} maxLength={100} required onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={ui.field}>
        Provedor
        <select className={ui.select} value={provider} onChange={(e) => setProvider(e.target.value as AgentDto["provider"])}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </label>
      {!props.providers[provider] ? <p className={ui.warn}>Sem chave configurada para este provedor — o agente não vai responder.</p> : null}
      <label className={ui.field}>
        Modelo
        <input className={ui.input} list="model-suggestions" value={model} maxLength={100} required onChange={(e) => setModel(e.target.value)} />
        <datalist id="model-suggestions">
          {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>
      <label className={ui.field}>
        Prompt (instruções do negócio)
        <textarea className={`${ui.textarea} ${ui.tall}`} value={systemPrompt} maxLength={20000} onChange={(e) => setSystemPrompt(e.target.value)} />
      </label>
      <label className={ui.field}>
        Mensagem de transferência
        <input className={ui.input} value={handoffMessage} maxLength={1000} required onChange={(e) => setHandoffMessage(e.target.value)} />
      </label>
      <label className={ui.row} style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Agente ativo
      </label>
      {!isActive ? <p className={ui.warn}>Desligado, o bot não responde ninguém neste número.</p> : null}
      {status ? <p className={status.kind === "error" ? ui.error : ui.muted}>{status.text}</p> : null}
      <div className={ui.row}>
        <button type="submit" className={ui.button} disabled={busy}>Salvar</button>
        <button type="button" className={ui.secondary} onClick={props.onClose}>Fechar</button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Build**

Run: `cd apps/dashboard && npx next build`
Expected: succeeds with route `/dashboard/agents`.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/app/dashboard/agents
git commit -m "feat(dashboard): agent per number - create and edit"
```

---

### Task 10: Numbers (instances) page

**Files:**
- Create: `apps/dashboard/app/dashboard/instances/page.tsx`
- Create: `apps/dashboard/app/dashboard/instances/QrPanel.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`, `usePolling`, `formatPhone`, types `InstanceRow`, `QrResponse`, `../ui.module.css` (Task 7); existing routes `GET /instances`, `POST /instances` (201 row), `GET /instances/:id/qr` (`{ qrcode, pairingCode }`; `qrcode` is a data URL or null when already paired), `DELETE /instances/:id` (204).

- [ ] **Step 1: Write `QrPanel.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/browserApi";
import type { InstanceRow, QrResponse } from "../../../lib/types";
import ui from "../ui.module.css";

/** Fetches a QR once (WhatsApp codes expire; "Gerar novo QR" asks again). Status comes from the parent's polling. */
export function QrPanel(props: { instance: InstanceRow; onClose(): void }) {
  const [qr, setQr] = useState<QrResponse | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const connected = props.instance.status === "connected";

  useEffect(() => {
    if (connected) return;
    let cancelled = false;
    setQr(null);
    setError(false);
    apiFetch<QrResponse>(`/instances/${props.instance.id}/qr`)
      .then((result) => !cancelled && setQr(result))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [props.instance.id, attempt, connected]);

  return (
    <div className={ui.card} style={{ marginTop: 16 }}>
      <h2>Parear {props.instance.name}</h2>
      {connected ? (
        <p>Conectado ✓</p>
      ) : error ? (
        <p className={ui.error}>A Evolution API não respondeu. Tente gerar o QR de novo.</p>
      ) : !qr ? (
        <p className={ui.muted}>Gerando QR…</p>
      ) : qr.qrcode ? (
        <>
          <p>No celular: WhatsApp → Aparelhos conectados → Conectar aparelho.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={ui.qr} src={qr.qrcode} alt="QR code para parear o WhatsApp" />
          {qr.pairingCode ? <p className={ui.muted}>Código de pareamento: {qr.pairingCode}</p> : null}
        </>
      ) : (
        <p className={ui.muted}>A Evolution não devolveu QR — o número pode já estar pareado.</p>
      )}
      <div className={ui.row}>
        {!connected ? (
          <button type="button" className={ui.secondary} onClick={() => setAttempt((n) => n + 1)}>Gerar novo QR</button>
        ) : null}
        <button type="button" className={ui.secondary} onClick={props.onClose}>Fechar</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `page.tsx`**

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "../../../lib/browserApi";
import { ApiError } from "../../../lib/api";
import { formatPhone } from "../../../lib/format";
import { usePolling } from "../../../lib/usePolling";
import type { InstanceRow } from "../../../lib/types";
import { QrPanel } from "./QrPanel";
import ui from "../ui.module.css";

const STATUS_LABEL: Record<string, string> = {
  created: "criado",
  connecting: "conectando",
  connected: "conectado",
  disconnected: "desconectado",
};

export default function InstancesPage() {
  const list = usePolling(() => apiFetch<InstanceRow[]>("/instances"), "instances");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<InstanceRow | null>(null);
  const [typedName, setTypedName] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const row = await apiFetch<InstanceRow>("/instances", { method: "POST", body: { name: newName.trim() } });
      setNewName("");
      await list.refresh();
      setQrFor(row.id);
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 502 ? "A Evolution API não respondeu." : "Não foi possível criar o número.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/instances/${removing.id}`, { method: "DELETE" });
      if (qrFor === removing.id) setQrFor(null);
      setRemoving(null);
      setTypedName("");
      await list.refresh();
    } catch {
      setMessage("Não foi possível remover o número.");
    } finally {
      setBusy(false);
    }
  }

  const qrInstance = list.data?.find((row) => row.id === qrFor) ?? null;

  return (
    <div>
      <h1>Números</h1>
      <form className={ui.row} onSubmit={create} style={{ marginBottom: 16 }}>
        <input
          className={ui.input}
          style={{ maxWidth: 280 }}
          placeholder="Nome do novo número (ex.: loja-centro)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className={ui.button} disabled={busy || !newName.trim()}>Novo número</button>
      </form>
      {message ? <p className={ui.error}>{message}</p> : null}
      <table className={ui.table}>
        <thead>
          <tr><th>Nome</th><th>Telefone</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{row.phone_number ? formatPhone(row.phone_number) : "—"}</td>
              <td>{STATUS_LABEL[row.status] ?? row.status}</td>
              <td className={ui.row}>
                <button type="button" className={ui.secondary} onClick={() => setQrFor(row.id)}>
                  {row.status === "connected" ? "Ver status" : "Ver QR"}
                </button>
                <button type="button" className={ui.secondary} onClick={() => { setRemoving(row); setTypedName(""); }}>
                  Remover
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {removing ? (
        <div className={`${ui.card} ${ui.warn}`} style={{ marginTop: 16 }}>
          <p>
            Remover <strong>{removing.name}</strong> desconecta o WhatsApp e apaga <strong>todas as conversas e mensagens</strong> deste número.
            Digite o nome para confirmar.
          </p>
          <div className={ui.row}>
            <input className={ui.input} style={{ maxWidth: 240 }} value={typedName} onChange={(e) => setTypedName(e.target.value)} />
            <button type="button" className={ui.danger} disabled={busy || typedName !== removing.name} onClick={() => void remove()}>
              Remover definitivamente
            </button>
            <button type="button" className={ui.secondary} onClick={() => setRemoving(null)}>Cancelar</button>
          </div>
        </div>
      ) : null}

      {qrInstance ? <QrPanel key={qrInstance.id} instance={qrInstance} onClose={() => setQrFor(null)} /> : null}
    </div>
  );
}
```

- [ ] **Step 3: Build and full suite**

Run (from repo root): `pnpm exec turbo run build test --force`
Expected: all tasks successful.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/app/dashboard/instances
git commit -m "feat(dashboard): numbers page with QR pairing and guarded removal"
```

---

### Task 11: End-to-end verification and ROADMAP

Manual, against the real fmagentes + CRM databases and real LLM, Evolution replaced by the local stub (VPS LID bug). Requires Tasks 1–10. The controller runs this; it needs the user for the items in Step 1.

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Prerequisites from the user**

1. A dashboard login: the user logs in themselves in the browser the controller drives, or sets a password for `teste@fmagentes.com` and shares it (the controller must not mint sessions without asking).
2. That login's e-mail must be in `apps/api/.env` `API_ALLOWED_USERS` (ask before editing) and, optionally, have a `team_members` row: `insert into team_members (user_id, display_name) values ('<auth uuid>', '<name>');`.
3. Permission to copy `CRM_SUPABASE_URL` / `CRM_SUPABASE_SERVICE_KEY` from `apps/worker/.env` into `apps/api/.env` (customer names).
4. The fmagentes Supabase project must be active (free tier pauses it).

- [ ] **Step 2: Start the stack with the Evolution stub**

1. `docker compose up -d redis`.
2. Run the stub (`<scratchpad>/evolution-stub.cjs`, same as sub-project 4: HTTP server on `127.0.0.1:4555` logging each request and answering `{"key":{"id":"STUB-<ts>"}}`; for `/instance/connect/*` answer `{"base64":"data:image/png;base64,iVBORw0KGgo=","pairingCode":"STUB-1234"}`, for `/instance/create` answer `{}`).
3. Temporarily set `EVOLUTION_API_URL=http://127.0.0.1:4555` in **both** `apps/worker/.env` and `apps/api/.env` (note originals to restore).
4. `pnpm dev` in the background; wait for `[worker] listening`, API on 3001, dashboard on 3000.

- [ ] **Step 3: Scenarios (browser at http://localhost:3000)**

Send customer messages by POSTing `messages.upsert` webhooks to `http://localhost:3001/webhooks/evolution` (header `apikey: <WEBHOOK_SECRET>`, instance `smoke-test-final`, unique `key.id`, phone `5511900000002`), as in sub-project 4.

1. **Handoff appears**: customer asks for a human with a quote request → within ~10 s the Inbox "Transferidas" tab shows it with the summary, the nav badge and the tab title `(1) fmagentes`.
2. **Assumir**: click Assumir → "Responsável: <me>"; "Minhas" tab lists it.
3. **Reply**: send "Oi, aqui é <nome>, já vejo seu pedido" → stub log shows the send; bubble shows the author; `messages.sent_by` = the user's id.
4. **Customer replies** → the conversation shows "aguardando resposta" within 10 s.
5. **Devolver ao bot** → confirmation → conversation leaves the queue; customer asks "E o prazo de entrega?" → bot answers and its answer reflects the human's message.
6. **Agents**: edit the number's agent prompt (e.g. add "Sempre termine com 'Bons ventos!'") → save → next customer message's answer follows it. Toggle a provider without key → warning shows.
7. **Numbers**: create "e2e-teste" → QR panel shows the stub image → remove it with the typed-name confirmation → row disappears.
8. **CPF badge**: in SQL set a test conversation's `crm_link_via = 'cpf'` → detail shows "CPF não verificado" and no name; revert.
9. **Mobile**: resize to 390 px wide → list and conversation are separate screens with "← Voltar".

Record per scenario what was seen (screenshots optional), worker log lines and relevant DB rows.

- [ ] **Step 4: Clean up**

Restore `EVOLUTION_API_URL` in both `.env` files; stop the stub and `pnpm dev` (kill the whole process tree — see ROADMAP "Local development notes"); revert any allowlist change the user did not want kept.

- [ ] **Step 5: ROADMAP**

In `docs/ROADMAP.md`:
- table row 5 → `✅ **Complete** (merged <pending>, <date>)`;
- add "## Sub-project 5 — Dashboard completo (done)" with: what was delivered (API routes, migration 0005, pages), the e2e evidence from Step 3, the five "Refinements to the spec" from this plan's header, and "Debt carried forward": the spec's Known gaps (Scope → Out list, provider availability inferred from the API env, `fromMe` not persisted) plus anything new found during e2e;
- add to "Local development notes": dashboard needs `API_URL` (or `NEXT_PUBLIC_API_URL`) for the `/api` proxy; team members need an Auth user + `API_ALLOWED_USERS` + optional `team_members` row.

- [ ] **Step 6: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs: encerra sub-projeto 5 com verificacao end-to-end"
```

Then use superpowers:finishing-a-development-branch.
