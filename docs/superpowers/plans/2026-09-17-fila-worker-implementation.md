# Fila/Worker (BullMQ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the logging stub on the `inbound-messages` queue with the real
pipeline — load context, pick an active agent, generate a reply through an
injected port, send it, and persist it — serialized per conversation and safe to
retry.

**Architecture:** The whole job is one dependency-injected domain operation,
`respondToInboundMessage`, living in `packages/messaging` alongside
`ingestInboundMessage` and `sendMessage`. It takes a `ResponderPort` (only
implementation here is an echo) and a `ConversationLock` (Redis in production,
fake in tests). `apps/worker` is pure composition: read env, build clients, set
queue/worker options, delegate.

**Tech Stack:** TypeScript (Node >= 22), pnpm workspaces + turbo, BullMQ 5 +
ioredis, Supabase JS 2, Vitest 2, Zod 3.

**Spec:** `docs/superpowers/specs/2026-09-17-fila-worker-design.md`

## Global Constraints

- Node engine floor is **>= 22** across the monorepo.
- `packages/messaging` **never reads env**. Every dependency arrives through
  `MessagingDeps`. Only `apps/*` call `loadEnv`.
- `packages/shared/src/index.ts` and `packages/messaging/src/index.ts` use
  **named exports**, never wildcard re-exports.
- Existing sub-project 2 call sites and tests must keep compiling untouched —
  new `MessagingDeps` fields are **optional**.
- TDD: write the failing test, watch it fail, then implement. One commit per
  task.
- `pnpm build` runs `tsc --noEmit` in all 6 packages; it must stay green.
- The Redis-backed tests need the `docker-compose` Redis container running.
  Docker Desktop is currently stopped — start it before Task 6.
- A running `pnpm dev` steals jobs from the queue and breaks queue tests. Kill
  the whole process tree (turbo + tsx-watch children), not just the port holder.

## Deviation from the spec, decided while planning

The spec's `RespondResult` has no case for "lock busy", but its job flow says the
*processor* reacts to a busy lock with `moveToDelayed`. The channel between them
is an exception: `respondToInboundMessage` throws `ConversationBusyError` and the
processor catches it. Also, BullMQ v5 requires throwing `DelayedError`
immediately after `job.moveToDelayed(...)` — returning normally makes the worker
complete the job anyway. Both are reflected in Tasks 1 and 7.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `packages/messaging/src/responder.ts` | `ResponderPort`, `AgentConfig`, `HistoryMessage`, `ResponderInput`, `EchoResponder` | 1 |
| `packages/messaging/src/conversationLock.ts` | `ConversationLock`, `ConversationBusyError`, `noopLock` | 1 |
| `packages/messaging/src/conversationHistory.ts` | `loadConversationHistory` | 2 |
| `packages/messaging/src/resolveAgent.ts` | `resolveAgentForConversation` (with auto-assignment) | 3 |
| `packages/messaging/src/respondToInboundMessage.ts` | the orchestration + `RespondResult` + `RespondDeps` | 4 |
| `packages/messaging/src/deps.ts` | two new **optional** fields | 1 |
| `packages/messaging/src/inboundQueue.ts` | `defaultJobOptions` | 5 |
| `packages/messaging/tests/support/supabaseMock.ts` | add the `gt` operator | 2 |
| `apps/worker/src/redisConversationLock.ts` | Redis lock (`SET NX PX` + nonce-checked Lua release) | 6 |
| `apps/worker/src/env.ts` | four new env vars | 6 |
| `apps/worker/src/inboundProcessor.ts` | stub → factory that delegates | 7 |
| `apps/worker/src/index.ts` | composition root, `concurrency` | 7 |
| `docs/ROADMAP.md` | sub-project 3 section + the `sendMessage` ordering debt | 8 |

---

### Task 1: Ports — responder, lock, and the deps they hang off

**Files:**
- Create: `packages/messaging/src/responder.ts`
- Create: `packages/messaging/src/conversationLock.ts`
- Modify: `packages/messaging/src/deps.ts`
- Modify: `packages/messaging/src/index.ts`
- Test: `packages/messaging/tests/responder.test.ts`

**Interfaces:**
- Consumes: nothing — this is the foundation task.
- Produces: `AgentConfig`, `HistoryMessage`, `ResponderInput`, `ResponderPort`,
  `EchoResponder`, `ConversationLock`, `ConversationBusyError`, `noopLock`, and
  the widened `MessagingDeps`. Every later task imports from here.

- [ ] **Step 1: Write the failing test**

Create `packages/messaging/tests/responder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EchoResponder } from "../src/responder";
import type { ResponderInput } from "../src/responder";

function input(text: string): ResponderInput {
  const incoming = { role: "user" as const, content: text, createdAt: "2026-09-17T10:00:00Z" };
  return {
    agent: { id: "a1", name: "Bot", provider: "anthropic", model: "claude-opus-5", systemPrompt: "" },
    history: [incoming],
    incoming,
  };
}

describe("EchoResponder", () => {
  it("echoes the incoming text back with a prefix", async () => {
    await expect(new EchoResponder().generate(input("oi"))).resolves.toBe("Echo: oi");
  });

  it("declines to answer an empty message", async () => {
    await expect(new EchoResponder().generate(input("   "))).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/messaging test -- responder`
Expected: FAIL — `Cannot find module '../src/responder'`.

- [ ] **Step 3: Write the responder**

Create `packages/messaging/src/responder.ts`:

```ts
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
```

- [ ] **Step 4: Write the lock contract**

Create `packages/messaging/src/conversationLock.ts`:

```ts
export interface LockHandle {
  release(): Promise<void>;
}

export interface ConversationLock {
  /** Resolves to a handle, or null when another worker holds the lock. */
  acquire(conversationId: string): Promise<LockHandle | null>;
}

/**
 * Thrown when the conversation is already being processed. The worker's
 * processor catches this and reschedules the job instead of failing it, so a
 * busy lock never consumes a retry attempt.
 */
export class ConversationBusyError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation is already being processed: ${conversationId}`);
    this.name = "ConversationBusyError";
  }
}

/** Always acquires. For unit tests and single-process local runs. */
export const noopLock: ConversationLock = {
  async acquire() {
    return { async release() {} };
  },
};
```

- [ ] **Step 5: Widen `MessagingDeps`**

Replace `packages/messaging/src/deps.ts` with:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";
import type { ResponderPort } from "./responder";
import type { ConversationLock } from "./conversationLock";

export interface MessagingDeps {
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
  /** Required only by respondToInboundMessage — see RespondDeps. */
  responder?: ResponderPort;
  /** Required only by respondToInboundMessage — see RespondDeps. */
  conversationLock?: ConversationLock;
}
```

Both fields are optional so every sub-project 2 call site and test keeps
compiling without edits.

- [ ] **Step 6: Export from the package index**

Append to `packages/messaging/src/index.ts`:

```ts
export {
  EchoResponder,
  type AgentConfig,
  type HistoryMessage,
  type ResponderInput,
  type ResponderPort,
} from "./responder";
export {
  ConversationBusyError,
  noopLock,
  type ConversationLock,
  type LockHandle,
} from "./conversationLock";
```

- [ ] **Step 7: Run tests and the build**

Run: `pnpm --filter @fmagentes/messaging test` then `pnpm build`
Expected: responder tests PASS, every pre-existing messaging test still PASS,
build 6/6.

- [ ] **Step 8: Commit**

```bash
git add packages/messaging/src/responder.ts packages/messaging/src/conversationLock.ts packages/messaging/src/deps.ts packages/messaging/src/index.ts packages/messaging/tests/responder.test.ts
git commit -m "feat(messaging): portas de responder e lock de conversa"
```

---

### Task 2: Conversation history

**Files:**
- Create: `packages/messaging/src/conversationHistory.ts`
- Modify: `packages/messaging/tests/support/supabaseMock.ts`
- Modify: `packages/messaging/src/index.ts`
- Test: `packages/messaging/tests/conversationHistory.test.ts`

**Interfaces:**
- Consumes: `HistoryMessage` and `MessagingDeps` from Task 1.
- Produces: `loadConversationHistory(deps: MessagingDeps, conversationId: string,
  limit?: number): Promise<HistoryMessage[]>` — chronological, oldest first,
  default limit 20. Task 4 calls it.

The mock change is folded in here because this is the first task whose query
needs an operator the mock does not have yet (`gt`, used in Task 4; added now so
the mock is edited once).

- [ ] **Step 1: Write the failing test**

Create `packages/messaging/tests/conversationHistory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConversationHistory } from "../src/conversationHistory";
import { createSupabaseMock } from "./support/supabaseMock";

function deps(rows: unknown) {
  return { supabase: createSupabaseMock({ messages: () => ({ data: rows, error: null }) }) } as never;
}

describe("loadConversationHistory", () => {
  it("returns messages oldest-first with direction mapped to role", async () => {
    // The query orders newest-first; the function reverses it.
    const rows = [
      { direction: "out", content: "b", created_at: "2026-09-17T10:01:00Z" },
      { direction: "in", content: "a", created_at: "2026-09-17T10:00:00Z" },
    ];

    await expect(loadConversationHistory(deps(rows), "conv-1")).resolves.toEqual([
      { role: "user", content: "a", createdAt: "2026-09-17T10:00:00Z" },
      { role: "assistant", content: "b", createdAt: "2026-09-17T10:01:00Z" },
    ]);
  });

  it("returns an empty array when the conversation has no messages", async () => {
    await expect(loadConversationHistory(deps(null), "conv-1")).resolves.toEqual([]);
  });

  it("asks the database for the requested limit", async () => {
    const supabase = createSupabaseMock({ messages: () => ({ data: [], error: null }) });
    const recorded: unknown[][] = [];
    const original = supabase.from.bind(supabase);
    supabase.from = (table: string) => {
      const chain = original(table) as Record<string, (...a: unknown[]) => unknown>;
      const limit = chain.limit;
      chain.limit = (...args: unknown[]) => {
        recorded.push(args);
        return limit(...args);
      };
      return chain;
    };

    await loadConversationHistory({ supabase } as never, "conv-1", 5);

    expect(recorded).toEqual([[5]]);
  });

  it("throws when Supabase returns an error", async () => {
    const supabase = createSupabaseMock({
      messages: () => ({ data: null, error: { message: "boom" } }),
    });
    await expect(loadConversationHistory({ supabase } as never, "conv-1")).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/messaging test -- conversationHistory`
Expected: FAIL — `Cannot find module '../src/conversationHistory'`.

- [ ] **Step 3: Add the `gt` operator to the mock**

In `packages/messaging/tests/support/supabaseMock.ts`, extend the operator list
so chained `gt` calls are recorded like every other operator:

```ts
      for (const op of ["select", "insert", "upsert", "update", "delete", "eq", "gt", "order", "limit"]) {
```

- [ ] **Step 4: Write the implementation**

Create `packages/messaging/src/conversationHistory.ts`:

```ts
import type { MessagingDeps } from "./deps";
import type { HistoryMessage } from "./responder";
import { assertNoError } from "./internal/supabaseError";

export const DEFAULT_HISTORY_LIMIT = 20;

interface MessageRow {
  direction: "in" | "out";
  content: string;
  created_at: string;
}

/**
 * The most recent `limit` messages of a conversation, returned oldest-first.
 * The query sorts newest-first so the limit keeps the *latest* messages; the
 * array is reversed before returning.
 */
export async function loadConversationHistory(
  deps: MessagingDeps,
  conversationId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<HistoryMessage[]> {
  const result = await deps.supabase
    .from("messages")
    .select("direction, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  assertNoError(result.error);

  const rows = (result.data as MessageRow[] | null) ?? [];

  return rows
    .slice()
    .reverse()
    .map((row) => ({
      role: row.direction === "in" ? ("user" as const) : ("assistant" as const),
      content: row.content,
      createdAt: row.created_at,
    }));
}
```

- [ ] **Step 5: Export it**

Append to `packages/messaging/src/index.ts`:

```ts
export { loadConversationHistory, DEFAULT_HISTORY_LIMIT } from "./conversationHistory";
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @fmagentes/messaging test`
Expected: all PASS, including the sub-project 2 tests that share the mock.

- [ ] **Step 7: Commit**

```bash
git add packages/messaging/src/conversationHistory.ts packages/messaging/src/index.ts packages/messaging/tests/conversationHistory.test.ts packages/messaging/tests/support/supabaseMock.ts
git commit -m "feat(messaging): carrega historico da conversa"
```

---

### Task 3: Agent resolution with auto-assignment

**Files:**
- Create: `packages/messaging/src/resolveAgent.ts`
- Modify: `packages/messaging/src/index.ts`
- Test: `packages/messaging/tests/resolveAgent.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `MessagingDeps` from Task 1.
- Produces: `resolveAgentForConversation(deps, { conversationId, instanceId,
  agentId }): Promise<AgentConfig | null>`. `null` means no active agent. Task 4
  calls it.

Behaviour, stated exactly: when `agentId` is set, load that agent and return it
**only if it is still active** — a deactivated pinned agent yields `null`, the
same as having none. When `agentId` is null, pick the instance's active agents
ordered by `created_at` ascending, take the first, and persist it onto
`conversations.agent_id`.

- [ ] **Step 1: Write the failing test**

Create `packages/messaging/tests/resolveAgent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveAgentForConversation } from "../src/resolveAgent";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const AGENT_ROW = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-opus-5",
  system_prompt: "Seja breve.",
};

const EXPECTED = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-opus-5",
  systemPrompt: "Seja breve.",
};

function deps(agentRow: unknown, onConversationUpdate?: (calls: TableCall) => void) {
  const supabase = createSupabaseMock({
    agents: () => ({ data: agentRow, error: null }),
    conversations: (calls) => {
      onConversationUpdate?.(calls);
      return { data: null, error: null };
    },
  });
  return { supabase } as never;
}

describe("resolveAgentForConversation", () => {
  it("returns the pinned agent without touching the conversation", async () => {
    let updated = false;
    const d = deps(AGENT_ROW, (calls) => {
      if (calls.some((c) => c.op === "update")) updated = true;
    });

    const agent = await resolveAgentForConversation(d, {
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: "agent-1",
    });

    expect(agent).toEqual(EXPECTED);
    expect(updated).toBe(false);
  });

  it("returns null when the pinned agent is no longer active", async () => {
    const agent = await resolveAgentForConversation(deps(null), {
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: "agent-gone",
    });

    expect(agent).toBeNull();
  });

  it("picks the instance's active agent and pins it to the conversation", async () => {
    const updates: TableCall = [];
    const d = deps(AGENT_ROW, (calls) => {
      updates.length = 0;
      updates.push(...calls);
    });

    const agent = await resolveAgentForConversation(d, {
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: null,
    });

    expect(agent).toEqual(EXPECTED);
    expect(updates.some((c) => c.op === "update" && JSON.stringify(c.args).includes("agent-1"))).toBe(true);
  });

  it("returns null when the instance has no active agent", async () => {
    const agent = await resolveAgentForConversation(deps(null), {
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: null,
    });

    expect(agent).toBeNull();
  });

  it("throws when Supabase returns an error", async () => {
    const supabase = createSupabaseMock({
      agents: () => ({ data: null, error: { message: "boom" } }),
    });
    await expect(
      resolveAgentForConversation({ supabase } as never, {
        conversationId: "conv-1",
        instanceId: "inst-1",
        agentId: null,
      }),
    ).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/messaging test -- resolveAgent`
Expected: FAIL — `Cannot find module '../src/resolveAgent'`.

- [ ] **Step 3: Write the implementation**

Create `packages/messaging/src/resolveAgent.ts`:

```ts
import type { MessagingDeps } from "./deps";
import type { AgentConfig } from "./responder";
import { assertNoError } from "./internal/supabaseError";

const AGENT_COLUMNS = "id, name, provider, model, system_prompt";

interface AgentRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  system_prompt: string;
}

function toConfig(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    systemPrompt: row.system_prompt,
  };
}

/**
 * Resolves which agent answers a conversation.
 *
 * A pinned agent that has been deactivated resolves to null — the same as
 * having no agent at all — so deactivating an agent stops the bot everywhere,
 * not just on new conversations.
 */
export async function resolveAgentForConversation(
  deps: MessagingDeps,
  input: { conversationId: string; instanceId: string; agentId: string | null },
): Promise<AgentConfig | null> {
  if (input.agentId) {
    const pinned = await deps.supabase
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("id", input.agentId)
      .eq("is_active", true)
      .maybeSingle();
    assertNoError(pinned.error);

    const row = pinned.data as AgentRow | null;
    return row ? toConfig(row) : null;
  }

  const candidate = await deps.supabase
    .from("agents")
    .select(AGENT_COLUMNS)
    .eq("instance_id", input.instanceId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  assertNoError(candidate.error);

  const row = candidate.data as AgentRow | null;
  if (!row) return null;

  const pin = await deps.supabase
    .from("conversations")
    .update({ agent_id: row.id })
    .eq("id", input.conversationId);
  assertNoError(pin.error);

  return toConfig(row);
}
```

- [ ] **Step 4: Export it**

Append to `packages/messaging/src/index.ts`:

```ts
export { resolveAgentForConversation } from "./resolveAgent";
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @fmagentes/messaging test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/messaging/src/resolveAgent.ts packages/messaging/src/index.ts packages/messaging/tests/resolveAgent.test.ts
git commit -m "feat(messaging): resolucao de agente com auto-atribuicao"
```

---

### Task 4: The orchestration — `respondToInboundMessage`

**Files:**
- Create: `packages/messaging/src/respondToInboundMessage.ts`
- Modify: `packages/messaging/src/index.ts`
- Test: `packages/messaging/tests/respondToInboundMessage.test.ts`

**Interfaces:**
- Consumes: `ResponderPort`, `ConversationLock`, `ConversationBusyError`
  (Task 1), `loadConversationHistory` (Task 2), `resolveAgentForConversation`
  (Task 3), and the existing `sendMessage` / `ConversationNotFoundError`.
- Produces: `RespondDeps`, `RespondResult`, and
  `respondToInboundMessage(deps: RespondDeps, job: InboundJobData):
  Promise<RespondResult>`. Task 7's processor calls it.

- [ ] **Step 1: Write the failing test**

Create `packages/messaging/tests/respondToInboundMessage.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { respondToInboundMessage } from "../src/respondToInboundMessage";
import { ConversationBusyError } from "../src/conversationLock";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const JOB = { messageId: "msg-in", conversationId: "conv-1", instanceId: "inst-1" };

const INBOUND_ROW = {
  id: "msg-in",
  conversation_id: "conv-1",
  content: "ola",
  created_at: "2026-09-17T10:00:00Z",
  conversations: { id: "conv-1", instance_id: "inst-1", agent_id: "agent-1" },
};

const AGENT_ROW = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-opus-5",
  system_prompt: "Seja breve.",
};

interface Options {
  inbound?: unknown;
  agent?: unknown;
  newerOutbound?: unknown;
  reply?: string | null;
  lockBusy?: boolean;
  messagesError?: unknown;
  sendText?: ReturnType<typeof vi.fn>;
}

function build(options: Options = {}) {
  const release = vi.fn(async () => {});
  const supabase = createSupabaseMock({
    messages: (calls: TableCall) => {
      if (options.messagesError) return { data: null, error: options.messagesError };
      // The duplicate guard is the only query filtering on direction=out.
      const isGuard = calls.some((c) => c.op === "gt");
      if (isGuard) return { data: options.newerOutbound ?? null, error: null };
      // The history query orders; the inbound lookup does not.
      const isHistory = calls.some((c) => c.op === "order");
      if (isHistory) {
        return { data: [{ direction: "in", content: "ola", created_at: "2026-09-17T10:00:00Z" }], error: null };
      }
      if (calls.some((c) => c.op === "insert")) {
        return {
          data: { id: "msg-out", conversation_id: "conv-1", direction: "out", content: "Echo: ola", created_at: "2026-09-17T10:00:05Z" },
          error: null,
        };
      }
      return { data: options.inbound === undefined ? INBOUND_ROW : options.inbound, error: null };
    },
    agents: () => ({ data: options.agent === undefined ? AGENT_ROW : options.agent, error: null }),
    conversations: () => ({
      data: { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } },
      error: null,
    }),
  });

  const responder = {
    generate: vi.fn(async () => (options.reply === undefined ? "Echo: ola" : options.reply)),
  };
  const conversationLock = {
    acquire: vi.fn(async () => (options.lockBusy ? null : { release })),
  };
  const evolutionApi = {
    sendText: options.sendText ?? vi.fn().mockResolvedValue({ messageId: "EVO1" }),
  };

  return { deps: { supabase, evolutionApi, responder, conversationLock } as never, responder, conversationLock, release, evolutionApi };
}

describe("respondToInboundMessage", () => {
  it("generates a reply and sends it", async () => {
    const { deps, responder, release } = build();

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "sent", messageId: "msg-out" });
    expect(responder.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "agent-1", systemPrompt: "Seja breve." }),
        incoming: { role: "user", content: "ola", createdAt: "2026-09-17T10:00:00Z" },
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("throws ConversationBusyError when the lock is held", async () => {
    const { deps, responder } = build({ lockBusy: true });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toBeInstanceOf(ConversationBusyError);
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("skips when the inbound message no longer exists", async () => {
    const { deps } = build({ inbound: null });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({
      status: "skipped",
      reason: "message-not-found",
    });
  });

  it("skips when there is no active agent", async () => {
    const { deps, responder } = build({ agent: null });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({
      status: "skipped",
      reason: "no-active-agent",
    });
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("skips when a newer outbound message already answered", async () => {
    const { deps, responder } = build({ newerOutbound: { id: "msg-out-old" } });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({
      status: "skipped",
      reason: "already-answered",
    });
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("skips when the responder declines", async () => {
    const { deps, evolutionApi } = build({ reply: null });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({
      status: "skipped",
      reason: "responder-declined",
    });
    expect(evolutionApi.sendText).not.toHaveBeenCalled();
  });

  it("releases the lock when a step throws", async () => {
    const { deps, release } = build({ messagesError: { message: "boom" } });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates an Evolution failure so BullMQ retries", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("evolution timeout"));
    const { deps } = build({ sendText });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toThrow("evolution timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/messaging test -- respondToInboundMessage`
Expected: FAIL — `Cannot find module '../src/respondToInboundMessage'`.

- [ ] **Step 3: Write the implementation**

Create `packages/messaging/src/respondToInboundMessage.ts`:

```ts
import type { MessagingDeps } from "./deps";
import type { InboundJobData } from "./inboundQueue";
import type { HistoryMessage } from "./responder";
import { ConversationBusyError } from "./conversationLock";
import { loadConversationHistory } from "./conversationHistory";
import { resolveAgentForConversation } from "./resolveAgent";
import { sendMessage, ConversationNotFoundError } from "./sendMessage";
import { assertNoError } from "./internal/supabaseError";

export type RespondDeps = MessagingDeps &
  Required<Pick<MessagingDeps, "responder" | "conversationLock">>;

export type RespondResult =
  | { status: "sent"; messageId: string }
  | {
      status: "skipped";
      reason: "no-active-agent" | "already-answered" | "responder-declined" | "message-not-found";
    };

interface InboundRow {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
  conversations: { id: string; instance_id: string; agent_id: string | null } | null;
}

export async function respondToInboundMessage(
  deps: RespondDeps,
  job: InboundJobData,
): Promise<RespondResult> {
  const lock = await deps.conversationLock.acquire(job.conversationId);
  if (!lock) throw new ConversationBusyError(job.conversationId);

  try {
    const lookup = await deps.supabase
      .from("messages")
      .select("id, conversation_id, content, created_at, conversations(id, instance_id, agent_id)")
      .eq("id", job.messageId)
      .maybeSingle();
    assertNoError(lookup.error);

    const inbound = lookup.data as InboundRow | null;
    if (!inbound || !inbound.conversations) {
      return { status: "skipped", reason: "message-not-found" };
    }

    const agent = await resolveAgentForConversation(deps, {
      conversationId: inbound.conversations.id,
      instanceId: inbound.conversations.instance_id,
      agentId: inbound.conversations.agent_id,
    });
    if (!agent) return { status: "skipped", reason: "no-active-agent" };

    // Retry safety: if anything outbound landed after this message, a previous
    // attempt already answered it.
    const answered = await deps.supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", inbound.conversation_id)
      .eq("direction", "out")
      .gt("created_at", inbound.created_at)
      .limit(1)
      .maybeSingle();
    assertNoError(answered.error);
    if (answered.data) return { status: "skipped", reason: "already-answered" };

    const history = await loadConversationHistory(deps, inbound.conversation_id);
    const incoming: HistoryMessage = {
      role: "user",
      content: inbound.content,
      createdAt: inbound.created_at,
    };

    const reply = await deps.responder.generate({ agent, history, incoming });
    if (reply === null) return { status: "skipped", reason: "responder-declined" };

    try {
      const sent = await sendMessage(deps, { conversationId: inbound.conversation_id, text: reply });
      return { status: "sent", messageId: sent.id };
    } catch (error) {
      // The conversation vanished mid-flight; retrying cannot fix that.
      if (error instanceof ConversationNotFoundError) {
        return { status: "skipped", reason: "message-not-found" };
      }
      throw error;
    }
  } finally {
    await lock.release();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/messaging test -- respondToInboundMessage`
Expected: all 8 cases PASS.

- [ ] **Step 5: Export it**

Append to `packages/messaging/src/index.ts`:

```ts
export {
  respondToInboundMessage,
  type RespondDeps,
  type RespondResult,
} from "./respondToInboundMessage";
```

- [ ] **Step 6: Run the full package suite and the build**

Run: `pnpm --filter @fmagentes/messaging test` then `pnpm build`
Expected: all PASS, build 6/6.

- [ ] **Step 7: Commit**

```bash
git add packages/messaging/src/respondToInboundMessage.ts packages/messaging/src/index.ts packages/messaging/tests/respondToInboundMessage.test.ts
git commit -m "feat(messaging): orquestracao do job de mensagem recebida"
```

---

### Task 5: Queue retry policy

**Files:**
- Modify: `packages/messaging/src/inboundQueue.ts`
- Test: `packages/messaging/tests/inboundQueue.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `INBOUND_JOB_OPTIONS` (exported so the test can assert on it and so
  the worker can log it). `createInboundQueue`'s signature is unchanged, so
  `apps/api` needs no edit.

- [ ] **Step 1: Write the failing test**

Append to `packages/messaging/tests/inboundQueue.test.ts`:

```ts
import { INBOUND_JOB_OPTIONS } from "../src/inboundQueue";

describe("INBOUND_JOB_OPTIONS", () => {
  it("retries three times with exponential backoff", () => {
    expect(INBOUND_JOB_OPTIONS.attempts).toBe(3);
    expect(INBOUND_JOB_OPTIONS.backoff).toEqual({ type: "exponential", delay: 1000 });
  });

  it("caps how many finished jobs are retained", () => {
    expect(INBOUND_JOB_OPTIONS.removeOnComplete).toEqual({ count: 1000 });
    expect(INBOUND_JOB_OPTIONS.removeOnFail).toEqual({ count: 5000 });
  });
});
```

Keep the file's existing `import { describe, expect, it } from "vitest";` — add
only the new import line if `describe`/`expect`/`it` are already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/messaging test -- inboundQueue`
Expected: FAIL — `INBOUND_JOB_OPTIONS` is not exported.

- [ ] **Step 3: Write the implementation**

Replace `packages/messaging/src/inboundQueue.ts` with:

```ts
import { Queue, type DefaultJobOptions } from "bullmq";
import type { Redis } from "ioredis";

export const INBOUND_QUEUE_NAME = "inbound-messages";

export interface InboundJobData {
  messageId: string;
  conversationId: string;
  instanceId: string;
}

/**
 * Retry policy lives on the producer so there is exactly one place to change
 * it. Three attempts with exponential backoff covers a transient Supabase or
 * Evolution failure; the duplicate guard in respondToInboundMessage is what
 * makes those retries safe.
 */
export const INBOUND_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export function createInboundQueue(connection: Redis): Queue<InboundJobData> {
  return new Queue<InboundJobData>(INBOUND_QUEUE_NAME, {
    connection,
    defaultJobOptions: INBOUND_JOB_OPTIONS,
  });
}
```

- [ ] **Step 4: Export and run tests**

Add to `packages/messaging/src/index.ts`, extending the existing
`./inboundQueue` export line so it also exports `INBOUND_JOB_OPTIONS`.

Run: `pnpm --filter @fmagentes/messaging test` then `pnpm build`
Expected: all PASS, build 6/6.

- [ ] **Step 5: Commit**

```bash
git add packages/messaging/src/inboundQueue.ts packages/messaging/src/index.ts packages/messaging/tests/inboundQueue.test.ts
git commit -m "feat(messaging): retry com backoff na fila inbound"
```

---

### Task 6: Redis conversation lock and worker environment

**Files:**
- Create: `apps/worker/src/redisConversationLock.ts`
- Modify: `apps/worker/src/env.ts`
- Modify: `apps/worker/.env.example`
- Modify: `apps/worker/package.json`
- Test: `apps/worker/tests/redisConversationLock.test.ts`

**Interfaces:**
- Consumes: `ConversationLock` from Task 1.
- Produces: `createRedisConversationLock(redis: Redis, ttlMs?: number):
  ConversationLock` and a widened `loadEnv`. Task 7 uses both.

**This task needs a real Redis.** Start Docker Desktop first
(`C:\Users\Dell\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe`), then
`docker compose up -d redis`. If the WSL2 backend misbehaves, run `wsl --update`
and restart Docker Desktop.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/tests/redisConversationLock.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createRedisConversationLock } from "../src/redisConversationLock";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

beforeAll(async () => {
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

describe("createRedisConversationLock", () => {
  it("grants the lock to one holder at a time", async () => {
    const lock = createRedisConversationLock(redis);
    const id = randomUUID();

    const first = await lock.acquire(id);
    expect(first).not.toBeNull();
    expect(await lock.acquire(id)).toBeNull();

    await first!.release();
    const third = await lock.acquire(id);
    expect(third).not.toBeNull();
    await third!.release();
  });

  it("does not block different conversations", async () => {
    const lock = createRedisConversationLock(redis);
    const a = await lock.acquire(randomUUID());
    const b = await lock.acquire(randomUUID());

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it("releases only its own hold, never a successor's", async () => {
    const id = randomUUID();
    const shortLived = createRedisConversationLock(redis, 60);

    const first = await shortLived.acquire(id);
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120)); // let the TTL expire

    const second = await shortLived.acquire(id);
    expect(second).not.toBeNull();

    // The stale holder releasing must not free the new holder's lock.
    await first!.release();
    expect(await shortLived.acquire(id)).toBeNull();

    await second!.release();
  });

  it("expires the lock on its own after the TTL", async () => {
    const id = randomUUID();
    const shortLived = createRedisConversationLock(redis, 60);

    expect(await shortLived.acquire(id)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const later = await shortLived.acquire(id);
    expect(later).not.toBeNull();
    await later!.release();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/worker test -- redisConversationLock`
Expected: FAIL — `Cannot find module '../src/redisConversationLock'`.
If it fails on `redis.ping()` instead, Redis is not up — fix that first.

- [ ] **Step 3: Write the implementation**

Create `apps/worker/src/redisConversationLock.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { ConversationLock } from "@fmagentes/messaging";

/**
 * Deletes the key only when it still holds our nonce. Without this check a
 * holder whose TTL expired would release the *next* holder's lock.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/** Sized for the Evolution call, which has hung in production before. */
export const DEFAULT_LOCK_TTL_MS = 30_000;

export function createRedisConversationLock(
  redis: Redis,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
): ConversationLock {
  return {
    async acquire(conversationId: string) {
      const key = `lock:conv:${conversationId}`;
      const nonce = randomUUID();

      const acquired = await redis.set(key, nonce, "PX", ttlMs, "NX");
      if (acquired !== "OK") return null;

      return {
        async release() {
          await redis.eval(RELEASE_SCRIPT, 1, key, nonce);
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/worker test -- redisConversationLock`
Expected: 4 cases PASS.

- [ ] **Step 5: Widen the worker env**

Replace `apps/worker/src/env.ts` with:

```ts
import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

const schema = z.object({
  REDIS_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
});

export const loadEnv = createEnvLoader(schema);
export type Env = ReturnType<typeof loadEnv>;
```

Replace `apps/worker/.env.example` with:

```
REDIS_URL=redis://localhost:6379
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
EVOLUTION_API_URL=https://your-evolution-host
EVOLUTION_API_KEY=your-evolution-api-key
```

Then copy the four real values from `apps/api/.env` into `apps/worker/.env`
(create the file if absent). The worker refuses to boot without them.

- [ ] **Step 6: Add the Supabase dependency**

The worker now builds a Supabase client, so its types must resolve under pnpm's
strict linking. In `apps/worker/package.json`, add to `dependencies`:

```json
    "@supabase/supabase-js": "^2.45.4",
```

Run: `pnpm install`

- [ ] **Step 7: Verify the build**

Run: `pnpm build`
Expected: 6/6 green.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/redisConversationLock.ts apps/worker/src/env.ts apps/worker/.env.example apps/worker/package.json apps/worker/tests/redisConversationLock.test.ts pnpm-lock.yaml
git commit -m "feat(worker): lock de conversa em redis e env completo"
```

---

### Task 7: Wire the processor

**Files:**
- Modify: `apps/worker/src/inboundProcessor.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/tests/inboundProcessor.test.ts` (rewrite)

**Interfaces:**
- Consumes: `respondToInboundMessage`, `RespondDeps`, `ConversationBusyError`
  (Tasks 1 and 4), `createRedisConversationLock` and `loadEnv` (Task 6),
  `createSupabaseClient` / `createEvolutionApiClient` from `@fmagentes/shared`.
- Produces: `createInboundProcessor(deps: RespondDeps, options?: { retryDelayMs?:
  number }): (job, token?) => Promise<RespondResult | { status: "delayed" }>`.
  The default export shape changes from a bare function to a factory, which is
  why the old test is rewritten rather than extended.

**The BullMQ gotcha:** `job.moveToDelayed(...)` alone is not enough — the
processor must then throw `DelayedError`, or the worker marks the job completed
and the reschedule is lost.

- [ ] **Step 1: Write the failing test**

Replace `apps/worker/tests/inboundProcessor.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";
import { DelayedError, type Job } from "bullmq";
import { ConversationBusyError, type InboundJobData } from "@fmagentes/messaging";
import { createInboundProcessor } from "../src/inboundProcessor";

const DATA: InboundJobData = { messageId: "m1", conversationId: "c1", instanceId: "i1" };

function job(): Job<InboundJobData> & { moveToDelayed: ReturnType<typeof vi.fn> } {
  return {
    id: "j1",
    data: DATA,
    moveToDelayed: vi.fn(async () => {}),
  } as never;
}

describe("createInboundProcessor", () => {
  it("delegates to respondToInboundMessage and returns its result", async () => {
    const respond = vi.fn(async () => ({ status: "sent", messageId: "msg-out" }));
    const process = createInboundProcessor({} as never, { respond: respond as never });

    await expect(process(job(), "tok")).resolves.toEqual({ status: "sent", messageId: "msg-out" });
    expect(respond).toHaveBeenCalledWith({}, DATA);
  });

  it("reschedules instead of failing when the conversation is busy", async () => {
    const respond = vi.fn(async () => {
      throw new ConversationBusyError("c1");
    });
    const j = job();
    const process = createInboundProcessor({} as never, {
      respond: respond as never,
      retryDelayMs: 2000,
    });

    await expect(process(j, "tok")).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledOnce();
    const [timestamp, token] = j.moveToDelayed.mock.calls[0];
    expect(token).toBe("tok");
    expect(timestamp).toBeGreaterThan(Date.now());
  });

  it("propagates any other error so BullMQ retries", async () => {
    const respond = vi.fn(async () => {
      throw new Error("supabase down");
    });
    const process = createInboundProcessor({} as never, { respond: respond as never });

    await expect(process(job(), "tok")).rejects.toThrow("supabase down");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/worker test -- inboundProcessor`
Expected: FAIL — `createInboundProcessor` is not exported.

- [ ] **Step 3: Write the implementation**

Replace `apps/worker/src/inboundProcessor.ts` with:

```ts
import { DelayedError, type Job } from "bullmq";
import {
  ConversationBusyError,
  respondToInboundMessage,
  type InboundJobData,
  type RespondDeps,
  type RespondResult,
} from "@fmagentes/messaging";

export const DEFAULT_BUSY_RETRY_MS = 2000;

export type ProcessorResult = RespondResult | { status: "delayed" };

interface Options {
  retryDelayMs?: number;
  /** Seam for tests; production always uses the real operation. */
  respond?: typeof respondToInboundMessage;
}

export function createInboundProcessor(deps: RespondDeps, options: Options = {}) {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_BUSY_RETRY_MS;
  const respond = options.respond ?? respondToInboundMessage;

  return async function processInboundJob(
    job: Job<InboundJobData>,
    token?: string,
  ): Promise<ProcessorResult> {
    try {
      const result = await respond(deps, job.data);
      console.log(`[worker] job ${job.id} message ${job.data.messageId}: ${result.status}`);
      return result;
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        // Another worker holds the conversation. Reschedule without burning an
        // attempt. moveToDelayed must be followed by DelayedError, otherwise
        // BullMQ completes the job and the reschedule is silently dropped.
        await job.moveToDelayed(Date.now() + retryDelayMs, token);
        throw new DelayedError();
      }
      throw error;
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/worker test -- inboundProcessor`
Expected: 3 cases PASS.

- [ ] **Step 5: Rewrite the composition root**

Replace `apps/worker/src/index.ts` with:

```ts
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { createSupabaseClient, createEvolutionApiClient } from "@fmagentes/shared";
import { EchoResponder, INBOUND_QUEUE_NAME, type RespondDeps } from "@fmagentes/messaging";
import { loadEnv } from "./env";
import { createInboundProcessor } from "./inboundProcessor";
import { createRedisConversationLock } from "./redisConversationLock";

const WORKER_CONCURRENCY = 5;

const env = loadEnv();

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const deps: RespondDeps = {
  supabase: createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY }),
  evolutionApi: createEvolutionApiClient({
    baseUrl: env.EVOLUTION_API_URL,
    apiKey: env.EVOLUTION_API_KEY,
  }),
  // Sub-project 4 swaps this one line for the LLM-backed responder.
  responder: new EchoResponder(),
  conversationLock: createRedisConversationLock(connection),
};

const worker = new Worker(INBOUND_QUEUE_NAME, createInboundProcessor(deps), {
  connection,
  concurrency: WORKER_CONCURRENCY,
});

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

console.log(`[worker] listening on ${INBOUND_QUEUE_NAME} with concurrency ${WORKER_CONCURRENCY}`);
```

- [ ] **Step 6: Run the whole suite and the build**

Run: `pnpm build` then `pnpm test`
Expected: build 6/6; all 9 packages green. Redis must be up, and no `pnpm dev`
may be running (its worker steals queued jobs and breaks `e2e-queue`).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/inboundProcessor.ts apps/worker/src/index.ts apps/worker/tests/inboundProcessor.test.ts
git commit -m "feat(worker): processa jobs reais da fila inbound"
```

---

### Task 8: End-to-end proof through the database, and docs

**Files:**
- Create: `scripts/seed-test-agent.sql`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the recorded verification evidence; no code other tasks depend on.

The success criterion is the persisted `out` row, **not** delivery to a phone —
the VPS Evolution 2.3.1 LID bug blocks real WhatsApp traffic and upgrading it is
out of scope.

- [ ] **Step 1: Seed an active agent**

Create `scripts/seed-test-agent.sql`:

```sql
-- Sub-project 3 verification: the pipeline skips conversations with no active
-- agent, so one must exist for the instance under test.
-- Replace :instance_id with the instances.id you are exercising.
insert into agents (name, provider, model, system_prompt, instance_id, is_active)
values ('Echo de teste', 'echo', 'echo-v1', '', :'instance_id', true);
```

Run it in the Supabase SQL editor against the instance you are testing, and
confirm one row came back.

- [ ] **Step 2: Start the stack**

```bash
docker compose up -d redis
pnpm dev
```

Check `http://localhost:3000/health` reports all three dependencies connected.

- [ ] **Step 3: Drive a message through the webhook**

POST the real `messages.upsert` fixture to `POST /webhooks/evolution` with the
`apikey` header set to `WEBHOOK_SECRET`, using a `contact_phone` you can find
again and a fresh `evolution_message_id` (a repeated id is deduplicated by
design and will produce nothing).

- [ ] **Step 4: Confirm the evidence in Supabase**

Run in the SQL editor:

```sql
select direction, role, content, created_at
from messages
where conversation_id = (
  select id from conversations where contact_phone = '<the phone you used>'
)
order by created_at;
```

Expected: the `in` row from the webhook, then an `out` row whose content starts
with `Echo: `. Also confirm `conversations.agent_id` is no longer null — that is
the auto-assignment having fired.

If the `out` row is missing, read the worker's log line
(`[worker] job <id> message <id>: <status>`) — the `status` names exactly which
gate stopped it.

- [ ] **Step 5: Expect the Evolution failure**

The `sendText` call will fail against the VPS while the LID bug stands. That is
the known external blocker, not a defect in this work: `sendMessage` sends
before persisting, so a failure there means **no** `out` row. Record what
actually happened. If Evolution does fail, prove the pipeline instead by
pointing the worker at a stub Evolution URL that returns a `messageId`, and note
in the ROADMAP which of the two paths produced the evidence.

- [ ] **Step 6: Update the ROADMAP**

In `docs/ROADMAP.md`: flip sub-project 3 to complete in the table, add a
"Sub-project 3 — Fila/Worker (done)" section listing what shipped
(`respondToInboundMessage`, `ResponderPort` + `EchoResponder`, the Redis
conversation lock, agent auto-assignment, the duplicate guard, retry with
backoff), the verification results from Steps 4 and 5, and any deviations from
this plan. Add to the debt section: **`sendMessage` calls Evolution before
persisting — a failed persist leaves a message delivered on WhatsApp that the
duplicate guard cannot see, so the retry sends it twice.**

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-test-agent.sql docs/ROADMAP.md
git commit -m "docs: encerra sub-projeto 3 com verificacao via banco"
```

---

## Self-review notes

Checked against the spec:

- Every spec section maps to a task: ports → 1, history → 2, agent gate → 3,
  flow + duplicate guard + error table → 4, queue config → 5, lock + env → 6,
  processor + composition → 7, verification + known gaps → 8.
- No placeholders: every code step carries the real code; the only `<...>`
  markers are runtime values (a phone number, an instance id) that cannot be
  known ahead of time.
- Type consistency verified across tasks: `AgentConfig.systemPrompt` (camelCase
  in the port, `system_prompt` in the row mapper), `ConversationLock.acquire`
  returning `LockHandle | null`, `RespondResult` reasons identical in Tasks 4
  and 7, `createInboundProcessor` signature identical in its test and its
  composition.
- Two spec refinements are recorded at the top: `ConversationBusyError` as the
  busy channel, and `DelayedError` after `moveToDelayed`.
