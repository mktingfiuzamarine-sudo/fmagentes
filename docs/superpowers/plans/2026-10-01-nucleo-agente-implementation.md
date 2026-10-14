# Núcleo do Agente/LLM + CRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `EchoResponder` with a real LLM agent (Anthropic/OpenAI per agent) that identifies the customer in the CRM by phone, registers unregistered customers (name, CPF, e-mail) through a tool, answers from the agent's prompt and hands off to a human through a tool — plus the handoff state, resume route, and the two sub-project 3 debts (two-clock guard, lock without renewal).

**Architecture:** `packages/messaging` keeps orchestrating (`respondToInboundMessage`) and owns every write to the fmagentes database; its data access moves behind a `RespondStore` so the orchestration is tested against an in-memory fake. A new `packages/agent` implements messaging's `ResponderPort` (`LlmResponder`, one `generateText` call with two tools) and messaging's `CustomerDirectoryPort` (the Supabase CRM adapter). `apps/worker` wires them; `apps/api` gains `POST /conversations/:id/resume`. The CRM repo (`C:\Users\Dell\Desktop\aula`) gains `cpf` + `phone_digits` and a CPF field.

**Tech Stack:** TypeScript (strict), pnpm 9 workspaces, Turbo, Vitest 2, Vercel AI SDK `ai@3.4.33` + `@ai-sdk/anthropic@0.0.50` + `@ai-sdk/openai@0.0.66`, Zod 3, Supabase JS 2, BullMQ 5, ioredis 5, Fastify 4. CRM: Next.js 15, react-hook-form, zod, Supabase.

**Spec:** `docs/superpowers/specs/2026-10-01-nucleo-agente-design.md`

## Global Constraints

- Node `>=22`, `pnpm@9.12.0`. Python does not exist on this machine — never use `python` in commands.
- Keep `ai@^3.4.0` / `@ai-sdk/anthropic@^0.0.50` / `@ai-sdk/openai@^0.0.66` — no upgrade: prompt caching is expressible (`cacheControl: true` model setting + `experimental_providerMetadata.anthropic.cacheControl` on a system message), verified in the installed sources.
- Validation model: Anthropic **Claude Haiku 4.5**, model id `claude-haiku-4-5`.
- `AGENT_HISTORY_LIMIT` optional, default **30**.
- LLM call: `maxSteps: 3`, `maxRetries: 0` (BullMQ owns retries: 3 attempts, existing backoff), `abortSignal` timeout **45 s**.
- Default handoff message, verbatim: `Vou te passar para um atendente, já já alguém te responde.`
- Note on agent-created CRM clients, verbatim: `Cadastrado pelo agente WhatsApp`. Extra-phone note format: `Outro WhatsApp: {phone}`.
- Required registration fields: name, CPF, e-mail. CPF stored as 11 digits only.
- `packages/messaging` must not import `ai`, `@ai-sdk/*` or anything CRM-specific. `packages/agent` never writes to the fmagentes database.
- CRM application code never writes `phone_digits` (or `search_vector`) — both are generated columns.
- Customer-facing and model-facing text is Portuguese; code identifiers and comments are English (codebase convention).
- A CPF-linked conversation (`crm_link_via = 'cpf'`) never receives stored client data — no name in the context, no fields from the tool.
- Redis-backed tests need the `docker compose` Redis (`127.0.0.1:6379`) running.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Refinements to the spec (decided while planning — record them in ROADMAP in Task 12)

1. **`handoff_at` = the triggering inbound's `received_at`**, not a fresh `now()`. PostgREST cannot write the DB's `now()` without an RPC, and writing the worker's clock would reintroduce the two-clock bug. Using the trigger's `received_at` keeps one clock and gives the exact rule the spec wants: inbound with `received_at <= handoff_at` is still owed the notice; later inbound is for the human.
2. **System prompt split in two system messages:** platform instructions + `agent.systemPrompt` (stable per agent → cached), then the per-conversation customer block. The spec's single block would change per customer and defeat caching.
3. **`cadastrar_cliente` is offered only when the customer is unregistered**, so a registered conversation can never be re-linked by the model.
4. **`CrmPort` gains `findById`** (needed to satisfy `CustomerDirectoryPort.findById`).
5. **Configuration errors** are `ResponderConfigurationError` (defined in messaging, part of the port contract); the worker maps them to BullMQ `UnrecoverableError`. The agent package does not depend on BullMQ.
6. **`RespondStore`** extracted from `respondToInboundMessage` (fake in tests); `sendMessage` stays as is.

## Review Focus

1. **A burst right before a handoff** — customer sends two messages; the first triggers a handoff; the second (received after the trigger) must be skipped as `awaiting-human`, not answered by the bot and not sent a second notice. Test in Task 4.
2. **History window that starts with an assistant message or contains a blank message** (window cut mid-conversation; empty text) — Anthropic rejects such prompts; `buildPrompt` must drop leading assistant and blank messages. Test in Task 5.
3. **WhatsApp numbers with/without the ninth digit, too short, or non-Brazilian** — must match the CRM client in the first case and never produce a broad suffix match in the others. Test in Task 6.
4. **CPF typed with punctuation/spaces, or a repeated-digit CPF like `111.111.111-11`** — first accepted and stored as digits, second rejected. Tests in Tasks 5 and 7.
5. **Resume called with a malformed id** (`/conversations/abc/resume`) — must answer 404, not 500 from a Postgres uuid cast error. Test in Task 9.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/0004_agent_core.sql` | handoff state, CRM link, `received_at`, `handoff_message` | 1 |
| `packages/messaging/src/conversationLock.ts` | `LockHandle.isLost()`, `LockLostError` | 2 |
| `apps/worker/src/redisConversationLock.ts` | heartbeat renewal | 2 |
| `packages/messaging/src/responder.ts` | `ResponderPort` contract v2, `EchoResponder`, `ResponderConfigurationError` | 3 |
| `packages/messaging/src/customerDirectory.ts` | `CustomerDirectoryPort` | 3 |
| `packages/messaging/src/respondStore.ts` | `RespondStore` + Supabase implementation | 3 |
| `packages/messaging/src/respondToInboundMessage.ts` | orchestration (handoff, CRM identification, lost lock) | 4 |
| `packages/messaging/tests/support/fakeRespondStore.ts` | in-memory store for tests | 4 |
| `packages/agent/*` (new package) | `cpf`, `buildPrompt`, CRM adapter, tools, `LlmResponder` | 5–8 |
| `packages/shared/src/llm.ts` | `getModel` cache-control option | 8 |
| `packages/messaging/src/resumeConversation.ts`, `apps/api/src/routes/conversations.ts` | resume | 9 |
| `apps/worker/src/{env,index,inboundProcessor}.ts` | composition + unrecoverable mapping | 10 |
| `C:\Users\Dell\Desktop\aula\…` (CRM repo) | migration 009, CPF in form/table | 11 |
| `scripts/seed-test-agent.sql`, `docs/ROADMAP.md` | e2e verification + record | 12 |

**Branches:** fmagentes work on `feat/nucleo-agente` (create via superpowers:using-git-worktrees at execution). CRM work on branch `feat/cpf-cliente` in `C:\Users\Dell\Desktop\aula` — that repo has unrelated uncommitted files (`.claude/settings.local.json`, `*.png`): always `git add` explicit paths there, never `-A`.

---

### Task 1: fmagentes migration `0004_agent_core.sql`

**Files:**
- Create: `supabase/migrations/0004_agent_core.sql`

**Interfaces:**
- Produces (columns later tasks read/write): `conversations.status in ('open','awaiting_human')`, `conversations.handoff_summary text`, `conversations.handoff_at timestamptz`, `conversations.crm_client_id uuid`, `conversations.crm_link_via text in ('phone','cpf','created')`, `agents.handoff_message text not null`, `messages.received_at timestamptz not null default now()`.

- [ ] **Step 1: Check existing statuses won't violate the new check**

Use `mcp__plugin_supabase_supabase__execute_sql` (project `odqqiteoskmfpwrlqyrb`; run `mcp__plugin_supabase_supabase__authenticate` first if the tool asks) with:

```sql
select status, count(*) from conversations group by status;
```

Expected: only `open` (or no rows). If any other value appears, stop and ask the user what it means before continuing.

- [ ] **Step 2: Write the migration**

```sql
-- Sub-project 4: agent core. Handoff state, link to the CRM client, and a
-- receipt time on the database clock for the duplicate guard.

alter table conversations
  add constraint conversations_status_check check (status in ('open', 'awaiting_human')),
  add column handoff_summary text,
  add column handoff_at timestamptz,
  add column crm_client_id uuid,
  add column crm_link_via text
    constraint conversations_crm_link_via_check check (crm_link_via in ('phone', 'cpf', 'created'));

comment on column conversations.handoff_at is
  'received_at of the inbound message that triggered the handoff (database clock). '
  'While awaiting_human, inbound received after it is left for the human.';
comment on column conversations.crm_client_id is
  'clients.id in the CRM database (a separate Supabase project) - no FK by design.';

alter table agents
  add column handoff_message text not null
    default 'Vou te passar para um atendente, já já alguém te responde.';

-- created_at of inbound rows carries the device timestamp; received_at is
-- always the database's now(), so the guard compares one clock with itself.
alter table messages
  add column received_at timestamptz not null default now();

update messages set received_at = created_at;
```

- [ ] **Step 3: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `{ project_id: "odqqiteoskmfpwrlqyrb", name: "agent_core", query: "<file contents>" }`. If that tool is unavailable, ask the user to paste the file into the Supabase dashboard → SQL Editor and run it.

- [ ] **Step 4: Verify**

`execute_sql`:

```sql
select column_name, data_type, column_default
from information_schema.columns
where table_name in ('conversations','agents','messages')
  and column_name in ('handoff_summary','handoff_at','crm_client_id','crm_link_via','handoff_message','received_at');
```

Expected: 6 rows. Then `select count(*) from messages where received_at <> created_at;` → `0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_agent_core.sql
git commit -m "feat(db): migration 0004 - handoff state, crm link, received_at"
```

---

### Task 2: Lock heartbeat (debt from sub-project 3)

**Files:**
- Modify: `packages/messaging/src/conversationLock.ts`
- Modify: `packages/messaging/src/index.ts`
- Modify: `apps/worker/src/redisConversationLock.ts`
- Test: `apps/worker/tests/redisConversationLock.test.ts`

**Interfaces:**
- Produces:
  - `interface LockHandle { isLost(): boolean; release(): Promise<void> }`
  - `class LockLostError extends Error { conversationId: string }` (exported from `@fmagentes/messaging`)
  - `noopLock` handles return `isLost: () => false`
  - `createRedisConversationLock(redis: Redis, ttlMs?: number, options?: { renewEveryMs?: number }): ConversationLock` — `renewEveryMs` defaults to `Math.floor(ttlMs / 3)`; `0` disables renewal (tests only: simulates a crashed holder)
  - `lockKey(conversationId: string): string` → `` `lock:conv:${conversationId}` ``

- [ ] **Step 1: Start Redis**

Run: `docker compose up -d redis` (start Docker Desktop first if it is stopped). Then `docker compose ps` → `redis` running.

- [ ] **Step 2: Write the failing tests**

Replace `apps/worker/tests/redisConversationLock.test.ts` with:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createRedisConversationLock, lockKey } from "../src/redisConversationLock";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // renewEveryMs: 0 simulates a holder that crashed and stopped renewing.
    const shortLived = createRedisConversationLock(redis, 60, { renewEveryMs: 0 });

    const first = await shortLived.acquire(id);
    expect(first).not.toBeNull();
    await wait(120); // let the TTL expire

    const second = await shortLived.acquire(id);
    expect(second).not.toBeNull();

    // The stale holder releasing must not free the new holder's lock.
    await first!.release();
    expect(await shortLived.acquire(id)).toBeNull();

    await second!.release();
  });

  it("expires the lock on its own when the holder stops renewing", async () => {
    const id = randomUUID();
    const shortLived = createRedisConversationLock(redis, 60, { renewEveryMs: 0 });

    expect(await shortLived.acquire(id)).not.toBeNull();
    await wait(120);
    const later = await shortLived.acquire(id);
    expect(later).not.toBeNull();
    await later!.release();
  });

  it("keeps the lock past its TTL while the holder is alive", async () => {
    const id = randomUUID();
    const lock = createRedisConversationLock(redis, 150);

    const held = await lock.acquire(id);
    expect(held).not.toBeNull();
    await wait(500); // more than three TTLs

    expect(await lock.acquire(id)).toBeNull();
    expect(held!.isLost()).toBe(false);

    await held!.release();
    const next = await lock.acquire(id);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it("reports lost when another holder took the key", async () => {
    const id = randomUUID();
    const lock = createRedisConversationLock(redis, 300);

    const held = await lock.acquire(id);
    await redis.set(lockKey(id), "someone-else", "PX", 5000);
    await wait(250); // renewal runs every 100 ms

    expect(held!.isLost()).toBe(true);
    await held!.release(); // must not delete the other holder's key
    expect(await redis.get(lockKey(id))).toBe("someone-else");
    await redis.del(lockKey(id));
  });

  it("reports lost when the key vanished", async () => {
    const id = randomUUID();
    const lock = createRedisConversationLock(redis, 300);

    const held = await lock.acquire(id);
    await redis.del(lockKey(id));
    await wait(250);

    expect(held!.isLost()).toBe(true);
    await held!.release();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/worker test -- redisConversationLock`
Expected: FAIL — `lockKey` is not exported / `isLost` is not a function.

- [ ] **Step 4: Update the lock contract in messaging**

Replace `packages/messaging/src/conversationLock.ts` with:

```ts
export interface LockHandle {
  /**
   * True once a renewal found the lock expired or taken by someone else. The
   * holder must not perform any side effect (send, handoff persist) after this.
   */
  isLost(): boolean;
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

/**
 * Thrown right before a side effect when the lock was lost mid-job. The job
 * fails and BullMQ retries it; the duplicate guard protects the retry.
 */
export class LockLostError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation lock lost before a side effect: ${conversationId}`);
    this.name = "LockLostError";
  }
}

/** Always acquires. For unit tests and single-process local runs. */
export const noopLock: ConversationLock = {
  async acquire() {
    return { isLost: () => false, async release() {} };
  },
};
```

In `packages/messaging/src/index.ts`, change the conversationLock export block to:

```ts
export {
  ConversationBusyError,
  LockLostError,
  noopLock,
  type ConversationLock,
  type LockHandle,
} from "./conversationLock";
```

- [ ] **Step 5: Implement the heartbeat**

Replace `apps/worker/src/redisConversationLock.ts` with:

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

/** Extends the TTL only while the key still holds our nonce. */
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Sized for the Evolution call, which has hung in production before. The
 * heartbeat keeps a live holder's lock past it; the TTL only bounds how long
 * a crashed holder blocks the conversation.
 */
export const DEFAULT_LOCK_TTL_MS = 30_000;

export interface RedisLockOptions {
  /** Defaults to a third of the TTL. 0 disables renewal (tests: a crashed holder). */
  renewEveryMs?: number;
}

export function lockKey(conversationId: string): string {
  return `lock:conv:${conversationId}`;
}

export function createRedisConversationLock(
  redis: Redis,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
  options: RedisLockOptions = {},
): ConversationLock {
  const renewEveryMs = options.renewEveryMs ?? Math.floor(ttlMs / 3);

  return {
    async acquire(conversationId: string) {
      const key = lockKey(conversationId);
      const nonce = randomUUID();

      const acquired = await redis.set(key, nonce, "PX", ttlMs, "NX");
      if (acquired !== "OK") return null;

      let lost = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const markLost = () => {
        lost = true;
        if (timer) clearInterval(timer);
      };

      if (renewEveryMs > 0) {
        timer = setInterval(() => {
          // A Redis error counts as lost too: we can no longer prove we hold it.
          redis.eval(RENEW_SCRIPT, 1, key, nonce, String(ttlMs)).then(
            (renewed) => {
              if (renewed !== 1) markLost();
            },
            markLost,
          );
        }, renewEveryMs);
        timer.unref();
      }

      return {
        isLost: () => lost,
        async release() {
          if (timer) clearInterval(timer);
          await redis.eval(RELEASE_SCRIPT, 1, key, nonce);
        },
      };
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @fmagentes/worker test` and `pnpm --filter @fmagentes/messaging build`
Expected: worker tests PASS (all 7 lock tests + processor tests); messaging `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add packages/messaging/src/conversationLock.ts packages/messaging/src/index.ts apps/worker/src/redisConversationLock.ts apps/worker/tests/redisConversationLock.test.ts
git commit -m "feat(worker): renew the conversation lock while held and report loss"
```

---

### Task 3: Responder contract v2, customer directory port, `RespondStore`

**Files:**
- Modify: `packages/messaging/src/responder.ts`
- Create: `packages/messaging/src/customerDirectory.ts`
- Create: `packages/messaging/src/respondStore.ts`
- Modify: `packages/messaging/src/resolveAgent.ts`
- Modify: `packages/messaging/src/conversationHistory.ts`
- Modify: `packages/messaging/src/index.ts`
- Test: `packages/messaging/tests/responder.test.ts`, `packages/messaging/tests/respondStore.test.ts`, `packages/messaging/tests/resolveAgent.test.ts`, `packages/messaging/tests/conversationHistory.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces (all exported from `@fmagentes/messaging`):
  ```ts
  interface AgentConfig { id: string; name: string; provider: string; model: string; systemPrompt: string; handoffMessage: string }
  interface HistoryMessage { role: "user" | "assistant"; content: string; createdAt: string }
  type CustomerContext = { status: "registered"; name?: string } | { status: "unregistered" }
  interface LinkedCustomer { crmClientId: string; via: "cpf" | "created" }
  type ResponderResult =
    | { kind: "reply"; text: string; linkedCustomer?: LinkedCustomer }
    | { kind: "handoff"; summary: string; linkedCustomer?: LinkedCustomer }
    | { kind: "decline"; linkedCustomer?: LinkedCustomer }
  interface ResponderInput { agent: AgentConfig; history: HistoryMessage[]; incoming: HistoryMessage; conversationId: string; contactPhone: string; customer: CustomerContext }
  interface ResponderPort { generate(input: ResponderInput): Promise<ResponderResult> }
  class ResponderConfigurationError extends Error { agentId: string }
  class EchoResponder implements ResponderPort
  interface DirectoryCustomer { id: string; name: string }
  interface CustomerDirectoryPort { findByPhone(phone: string): Promise<DirectoryCustomer | null>; findById(id: string): Promise<DirectoryCustomer | null> }
  type CrmLinkVia = "phone" | "cpf" | "created"
  type ConversationStatus = "open" | "awaiting_human"
  interface InboundContext { messageId; conversationId; instanceId; agentId: string | null; contactPhone; content; createdAt; receivedAt; conversationStatus: ConversationStatus; handoffAt: string | null; crmClientId: string | null; crmLinkVia: CrmLinkVia | null }
  interface RespondStore {
    loadInbound(messageId: string): Promise<InboundContext | null>;
    resolveAgent(input: { conversationId: string; instanceId: string; agentId: string | null }): Promise<AgentConfig | null>;
    hasOutboundAfter(conversationId: string, receivedAt: string): Promise<boolean>;
    loadHistory(conversationId: string, limit: number): Promise<HistoryMessage[]>;
    linkCustomer(conversationId: string, crmClientId: string, via: CrmLinkVia): Promise<void>;
    markAwaitingHuman(conversationId: string, handoff: { summary: string; handoffAt: string }): Promise<void>;
  }
  function createSupabaseRespondStore(supabase: SupabaseClient): RespondStore
  const DEFAULT_HISTORY_LIMIT = 30
  ```

- [ ] **Step 1: Write the failing tests**

Replace `packages/messaging/tests/responder.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { EchoResponder, ResponderConfigurationError } from "../src/responder";
import type { ResponderInput } from "../src/responder";

function input(text: string): ResponderInput {
  const incoming = { role: "user" as const, content: text, createdAt: "2026-09-17T10:00:00Z" };
  return {
    agent: {
      id: "a1",
      name: "Bot",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      systemPrompt: "",
      handoffMessage: "Já te passo.",
    },
    history: [incoming],
    incoming,
    conversationId: "conv-1",
    contactPhone: "5511999998888",
    customer: { status: "unregistered" },
  };
}

describe("EchoResponder", () => {
  it("echoes the incoming text back as a reply", async () => {
    await expect(new EchoResponder().generate(input("oi"))).resolves.toEqual({ kind: "reply", text: "Echo: oi" });
  });

  it("declines an empty message", async () => {
    await expect(new EchoResponder().generate(input("   "))).resolves.toEqual({ kind: "decline" });
  });
});

describe("ResponderConfigurationError", () => {
  it("carries the agent id", () => {
    const error = new ResponderConfigurationError("agent-9", "bad key");
    expect(error.agentId).toBe("agent-9");
    expect(error.message).toBe("bad key");
    expect(error.name).toBe("ResponderConfigurationError");
  });
});
```

Create `packages/messaging/tests/respondStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSupabaseRespondStore } from "../src/respondStore";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const INBOUND_ROW = {
  id: "msg-in",
  conversation_id: "conv-1",
  content: "ola",
  created_at: "2025-01-01T00:00:00Z",
  received_at: "2026-10-14T12:00:00.123456+00:00",
  conversations: {
    id: "conv-1",
    instance_id: "inst-1",
    agent_id: "agent-1",
    contact_phone: "5511999998888",
    status: "awaiting_human",
    handoff_at: "2026-10-14T12:00:00.123456+00:00",
    crm_client_id: "crm-1",
    crm_link_via: "phone",
  },
};

function storeWith(handlers: Record<string, (calls: TableCall) => { data: unknown; error: unknown }>) {
  return createSupabaseRespondStore(createSupabaseMock(handlers) as never);
}

describe("createSupabaseRespondStore", () => {
  it("loads the inbound message with its conversation state", async () => {
    const store = storeWith({ messages: () => ({ data: INBOUND_ROW, error: null }) });

    await expect(store.loadInbound("msg-in")).resolves.toEqual({
      messageId: "msg-in",
      conversationId: "conv-1",
      instanceId: "inst-1",
      agentId: "agent-1",
      contactPhone: "5511999998888",
      content: "ola",
      createdAt: "2025-01-01T00:00:00Z",
      receivedAt: "2026-10-14T12:00:00.123456+00:00",
      conversationStatus: "awaiting_human",
      handoffAt: "2026-10-14T12:00:00.123456+00:00",
      crmClientId: "crm-1",
      crmLinkVia: "phone",
    });
  });

  it("returns null when the message or its conversation is gone", async () => {
    await expect(storeWith({ messages: () => ({ data: null, error: null }) }).loadInbound("x")).resolves.toBeNull();
    await expect(
      storeWith({ messages: () => ({ data: { ...INBOUND_ROW, conversations: null }, error: null }) }).loadInbound("x"),
    ).resolves.toBeNull();
  });

  it("checks for outbound rows created after the inbound's received_at", async () => {
    let recorded: TableCall = [];
    const store = storeWith({
      messages: (calls) => {
        recorded = calls;
        return { data: { id: "out-1" }, error: null };
      },
    });

    await expect(store.hasOutboundAfter("conv-1", "2026-10-14T12:00:00Z")).resolves.toBe(true);
    expect(recorded).toEqual(
      expect.arrayContaining([
        { op: "eq", args: ["conversation_id", "conv-1"] },
        { op: "eq", args: ["direction", "out"] },
        { op: "gt", args: ["created_at", "2026-10-14T12:00:00Z"] },
      ]),
    );
  });

  it("reports no outbound when none exists", async () => {
    const store = storeWith({ messages: () => ({ data: null, error: null }) });
    await expect(store.hasOutboundAfter("conv-1", "2026-10-14T12:00:00Z")).resolves.toBe(false);
  });

  it("writes the CRM link onto the conversation", async () => {
    let recorded: TableCall = [];
    const store = storeWith({
      conversations: (calls) => {
        recorded = calls;
        return { data: null, error: null };
      },
    });

    await store.linkCustomer("conv-1", "crm-1", "cpf");

    expect(recorded).toEqual([
      { op: "update", args: [{ crm_client_id: "crm-1", crm_link_via: "cpf" }] },
      { op: "eq", args: ["id", "conv-1"] },
    ]);
  });

  it("marks the conversation awaiting a human", async () => {
    let recorded: TableCall = [];
    const store = storeWith({
      conversations: (calls) => {
        recorded = calls;
        return { data: null, error: null };
      },
    });

    await store.markAwaitingHuman("conv-1", { summary: "Quer orçamento", handoffAt: "2026-10-14T12:00:00Z" });

    expect(recorded).toEqual([
      {
        op: "update",
        args: [{ status: "awaiting_human", handoff_summary: "Quer orçamento", handoff_at: "2026-10-14T12:00:00Z" }],
      },
      { op: "eq", args: ["id", "conv-1"] },
    ]);
  });

  it("throws when a write fails", async () => {
    const store = storeWith({ conversations: () => ({ data: null, error: { message: "boom" } }) });
    await expect(store.linkCustomer("conv-1", "crm-1", "phone")).rejects.toThrow("boom");
  });
});
```

In `packages/messaging/tests/resolveAgent.test.ts`, add `handoff_message: "Já te passo."` to every agent row fixture and `handoffMessage: "Já te passo."` to every expected `AgentConfig`. (Open the file, search for `system_prompt` — each row and each expectation gets the matching field.)

In `packages/messaging/tests/conversationHistory.test.ts`, add at the end of the `describe` block:

```ts
  it("defaults to the 30 most recent messages", async () => {
    const recorded: unknown[][] = [];
    const supabase = createSupabaseMock({
      messages: (calls) => {
        const limitCall = calls.find((c) => c.op === "limit");
        if (limitCall) recorded.push(limitCall.args);
        return { data: [], error: null };
      },
    });

    await loadConversationHistory({ supabase } as never, "conv-1");

    expect(recorded).toEqual([[30]]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/messaging test`
Expected: FAIL — `respondStore` module missing, Echo returns a string, `ResponderConfigurationError` missing, default limit 20, `handoffMessage` missing. (`respondToInboundMessage.test.ts` may also fail — it is rewritten in Task 4.)

- [ ] **Step 3: Rewrite `responder.ts`**

```ts
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
```

- [ ] **Step 4: Create `customerDirectory.ts`**

```ts
export interface DirectoryCustomer {
  id: string;
  name: string;
}

/**
 * Read-only view of the CRM that messaging needs to identify a customer before
 * the model runs. Messaging never learns how the CRM is reached.
 */
export interface CustomerDirectoryPort {
  /** null when nobody, or more than one client, matches. */
  findByPhone(phone: string): Promise<DirectoryCustomer | null>;
  findById(id: string): Promise<DirectoryCustomer | null>;
}
```

- [ ] **Step 5: Narrow `resolveAgent` and `conversationHistory` deps, add `handoff_message`**

In `packages/messaging/src/resolveAgent.ts`:
- `const AGENT_COLUMNS = "id, name, provider, model, system_prompt, handoff_message";`
- add `handoff_message: string;` to `AgentRow`
- add `handoffMessage: row.handoff_message,` to `toConfig`
- change the signature's first parameter to `deps: Pick<MessagingDeps, "supabase">`

In `packages/messaging/src/conversationHistory.ts`:
- `export const DEFAULT_HISTORY_LIMIT = 30;`
- change the first parameter to `deps: Pick<MessagingDeps, "supabase">`

- [ ] **Step 6: Create `respondStore.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentConfig, HistoryMessage } from "./responder";
import { loadConversationHistory } from "./conversationHistory";
import { resolveAgentForConversation } from "./resolveAgent";
import { assertNoError } from "./internal/supabaseError";

export type CrmLinkVia = "phone" | "cpf" | "created";
export type ConversationStatus = "open" | "awaiting_human";

export interface InboundContext {
  messageId: string;
  conversationId: string;
  instanceId: string;
  agentId: string | null;
  contactPhone: string;
  content: string;
  /** Device timestamp; used only for history ordering. */
  createdAt: string;
  /** Database clock; used for every retry/handoff comparison. */
  receivedAt: string;
  conversationStatus: ConversationStatus;
  handoffAt: string | null;
  crmClientId: string | null;
  crmLinkVia: CrmLinkVia | null;
}

/** Every database read/write respondToInboundMessage needs, except sending. */
export interface RespondStore {
  loadInbound(messageId: string): Promise<InboundContext | null>;
  resolveAgent(input: { conversationId: string; instanceId: string; agentId: string | null }): Promise<AgentConfig | null>;
  /** Any outbound row created after `receivedAt` — both on the database clock. */
  hasOutboundAfter(conversationId: string, receivedAt: string): Promise<boolean>;
  loadHistory(conversationId: string, limit: number): Promise<HistoryMessage[]>;
  linkCustomer(conversationId: string, crmClientId: string, via: CrmLinkVia): Promise<void>;
  markAwaitingHuman(conversationId: string, handoff: { summary: string; handoffAt: string }): Promise<void>;
}

const INBOUND_COLUMNS =
  "id, conversation_id, content, created_at, received_at, " +
  "conversations(id, instance_id, agent_id, contact_phone, status, handoff_at, crm_client_id, crm_link_via)";

interface InboundRow {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
  received_at: string;
  conversations: {
    id: string;
    instance_id: string;
    agent_id: string | null;
    contact_phone: string;
    status: ConversationStatus;
    handoff_at: string | null;
    crm_client_id: string | null;
    crm_link_via: CrmLinkVia | null;
  } | null;
}

export function createSupabaseRespondStore(supabase: SupabaseClient): RespondStore {
  const deps = { supabase };

  return {
    async loadInbound(messageId) {
      const lookup = await supabase.from("messages").select(INBOUND_COLUMNS).eq("id", messageId).maybeSingle();
      assertNoError(lookup.error);

      const row = lookup.data as InboundRow | null;
      if (!row || !row.conversations) return null;
      const conversation = row.conversations;

      return {
        messageId: row.id,
        conversationId: conversation.id,
        instanceId: conversation.instance_id,
        agentId: conversation.agent_id,
        contactPhone: conversation.contact_phone,
        content: row.content,
        createdAt: row.created_at,
        receivedAt: row.received_at,
        conversationStatus: conversation.status,
        handoffAt: conversation.handoff_at,
        crmClientId: conversation.crm_client_id,
        crmLinkVia: conversation.crm_link_via,
      };
    },

    resolveAgent: (input) => resolveAgentForConversation(deps, input),

    async hasOutboundAfter(conversationId, receivedAt) {
      const answered = await supabase
        .from("messages")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("direction", "out")
        .gt("created_at", receivedAt)
        .limit(1)
        .maybeSingle();
      assertNoError(answered.error);
      return answered.data !== null;
    },

    loadHistory: (conversationId, limit) => loadConversationHistory(deps, conversationId, limit),

    async linkCustomer(conversationId, crmClientId, via) {
      const result = await supabase
        .from("conversations")
        .update({ crm_client_id: crmClientId, crm_link_via: via })
        .eq("id", conversationId);
      assertNoError(result.error);
    },

    async markAwaitingHuman(conversationId, handoff) {
      const result = await supabase
        .from("conversations")
        .update({ status: "awaiting_human", handoff_summary: handoff.summary, handoff_at: handoff.handoffAt })
        .eq("id", conversationId);
      assertNoError(result.error);
    },
  };
}
```

- [ ] **Step 7: Export the new surface**

In `packages/messaging/src/index.ts`, replace the responder export block with:

```ts
export {
  EchoResponder,
  ResponderConfigurationError,
  type AgentConfig,
  type CustomerContext,
  type HistoryMessage,
  type LinkedCustomer,
  type ResponderInput,
  type ResponderPort,
  type ResponderResult,
} from "./responder";
export type { CustomerDirectoryPort, DirectoryCustomer } from "./customerDirectory";
export {
  createSupabaseRespondStore,
  type ConversationStatus,
  type CrmLinkVia,
  type InboundContext,
  type RespondStore,
} from "./respondStore";
```

- [ ] **Step 8: Run tests**

Run: `pnpm --filter @fmagentes/messaging test -- responder respondStore resolveAgent conversationHistory`
Expected: PASS. (`respondToInboundMessage` is still on the old contract and does not type-check; Task 4 rewrites it — do not run `build` yet.)

- [ ] **Step 9: Commit**

```bash
git add packages/messaging/src packages/messaging/tests
git commit -m "feat(messaging): responder contract v2, customer directory port, respond store"
```

---

### Task 4: `respondToInboundMessage` — handoff, CRM identification, guard on `received_at`, lost lock

**Files:**
- Modify: `packages/messaging/src/respondToInboundMessage.ts`
- Modify: `packages/messaging/src/deps.ts`
- Modify: `packages/messaging/src/index.ts`
- Create: `packages/messaging/tests/support/fakeRespondStore.ts`
- Test: `packages/messaging/tests/respondToInboundMessage.test.ts` (rewrite)

**Interfaces:**
- Consumes: Task 2 `LockHandle.isLost`, `LockLostError`; Task 3 `RespondStore`, `CustomerDirectoryPort`, `ResponderResult`, `DEFAULT_HISTORY_LIMIT`.
- Produces:
  ```ts
  interface MessagingDeps { supabase: SupabaseClient; evolutionApi: EvolutionApiClient }
  type RespondDeps = MessagingDeps & {
    responder: ResponderPort;
    conversationLock: ConversationLock;
    customerDirectory: CustomerDirectoryPort;
    store?: RespondStore;        // default: createSupabaseRespondStore(supabase)
    historyLimit?: number;       // default: DEFAULT_HISTORY_LIMIT (30)
  };
  type RespondResult =
    | { status: "sent"; messageId: string }
    | { status: "handoff"; messageId: string }
    | { status: "skipped"; reason: "no-active-agent" | "already-answered" | "responder-declined" | "message-not-found" | "awaiting-human" };
  ```

- [ ] **Step 1: Write the fake store**

`packages/messaging/tests/support/fakeRespondStore.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing tests**

Replace `packages/messaging/tests/respondToInboundMessage.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";
import { respondToInboundMessage } from "../src/respondToInboundMessage";
import { ConversationBusyError, LockLostError } from "../src/conversationLock";
import type { ResponderResult } from "../src/responder";
import { createSupabaseMock } from "./support/supabaseMock";
import { AGENT, INBOUND, createFakeStore, type FakeStoreOptions } from "./support/fakeRespondStore";

const JOB = { messageId: "msg-in", conversationId: "conv-1", instanceId: "inst-1" };

interface Options {
  store?: FakeStoreOptions;
  result?: ResponderResult;
  lockBusy?: boolean;
  lockLost?: boolean;
  sendText?: ReturnType<typeof vi.fn>;
  conversationGone?: boolean;
  phoneMatch?: { id: string; name: string } | null;
  byId?: { id: string; name: string } | null;
  historyLimit?: number;
}

function build(options: Options = {}) {
  const store = createFakeStore(options.store);
  const release = vi.fn(async () => {});
  const conversationLock = {
    acquire: vi.fn(async () => (options.lockBusy ? null : { release, isLost: () => options.lockLost ?? false })),
  };
  const responder = {
    generate: vi.fn(async (): Promise<ResponderResult> => options.result ?? { kind: "reply", text: "Oi! Como posso ajudar?" }),
  };
  const customerDirectory = {
    findByPhone: vi.fn(async () => options.phoneMatch ?? null),
    findById: vi.fn(async () => options.byId ?? null),
  };
  // Only sendMessage still talks to Supabase directly: conversation lookup,
  // outbound insert, last_message_at update.
  const supabase = createSupabaseMock({
    conversations: () => ({
      data: options.conversationGone
        ? null
        : { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } },
      error: null,
    }),
    messages: () => ({
      data: { id: "msg-out", conversation_id: "conv-1", direction: "out", content: "x", created_at: "2026-10-14T12:00:05Z" },
      error: null,
    }),
  });
  const evolutionApi = { sendText: options.sendText ?? vi.fn().mockResolvedValue({ messageId: "EVO1" }) };

  const deps = {
    supabase,
    evolutionApi,
    responder,
    conversationLock,
    customerDirectory,
    store,
    historyLimit: options.historyLimit,
  } as never;
  return { deps, store, responder, release, evolutionApi, customerDirectory };
}

describe("respondToInboundMessage", () => {
  it("generates a reply and sends it", async () => {
    const { deps, responder, evolutionApi, release } = build();

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "sent", messageId: "msg-out" });
    expect(responder.generate).toHaveBeenCalledWith({
      agent: AGENT,
      history: [{ role: "user", content: "ola", createdAt: INBOUND.createdAt }],
      incoming: { role: "user", content: "ola", createdAt: INBOUND.createdAt },
      conversationId: "conv-1",
      contactPhone: "5511999998888",
      customer: { status: "unregistered" },
    });
    expect(evolutionApi.sendText).toHaveBeenCalledWith("acme", "5511999998888", "Oi! Como posso ajudar?");
    expect(release).toHaveBeenCalledOnce();
  });

  it("throws ConversationBusyError when the lock is held", async () => {
    const { deps, responder, release } = build({ lockBusy: true });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toBeInstanceOf(ConversationBusyError);
    expect(responder.generate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("skips when the inbound message no longer exists", async () => {
    const { deps } = build({ store: { inbound: null } });
    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "message-not-found" });
  });

  it("skips when there is no active agent", async () => {
    const { deps, responder } = build({ store: { agent: null } });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "no-active-agent" });
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("guards duplicates with the database receipt time, not the device timestamp", async () => {
    const { deps, store, responder } = build({ store: { answered: true } });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "already-answered" });
    expect(store.hasOutboundAfter).toHaveBeenCalledWith("conv-1", INBOUND.receivedAt);
    expect(responder.generate).not.toHaveBeenCalled();
  });

  it("skips when the responder declines", async () => {
    const { deps, evolutionApi } = build({ result: { kind: "decline" } });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "responder-declined" });
    expect(evolutionApi.sendText).not.toHaveBeenCalled();
  });

  it("loads 30 history messages by default and honours historyLimit", async () => {
    const first = build();
    await respondToInboundMessage(first.deps, JOB);
    expect(first.store.loadHistory).toHaveBeenCalledWith("conv-1", 30);

    const second = build({ historyLimit: 5 });
    await respondToInboundMessage(second.deps, JOB);
    expect(second.store.loadHistory).toHaveBeenCalledWith("conv-1", 5);
  });

  it("releases the lock when a step throws", async () => {
    const { deps, store, release } = build();
    store.loadInbound.mockRejectedValueOnce(new Error("boom"));

    await expect(respondToInboundMessage(deps, JOB)).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates an Evolution failure so BullMQ retries", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("evolution timeout"));
    const { deps, release } = build({ sendText });

    await expect(respondToInboundMessage(deps, JOB)).rejects.toThrow("evolution timeout");
    expect(release).toHaveBeenCalledOnce();
  });

  it("skips when the conversation vanishes before sending", async () => {
    const { deps, responder, evolutionApi } = build({ conversationGone: true });

    await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "message-not-found" });
    expect(responder.generate).toHaveBeenCalledOnce();
    expect(evolutionApi.sendText).not.toHaveBeenCalled();
  });

  describe("handoff", () => {
    it("persists the handoff, then sends the agent's handoff message", async () => {
      const { deps, store, evolutionApi } = build({ result: { kind: "handoff", summary: "Quer orçamento de casco" } });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "handoff", messageId: "msg-out" });
      expect(store.markAwaitingHuman).toHaveBeenCalledWith("conv-1", {
        summary: "Quer orçamento de casco",
        handoffAt: INBOUND.receivedAt,
      });
      expect(evolutionApi.sendText).toHaveBeenCalledWith("acme", "5511999998888", AGENT.handoffMessage);
      expect(store.markAwaitingHuman.mock.invocationCallOrder[0]).toBeLessThan(
        evolutionApi.sendText.mock.invocationCallOrder[0],
      );
    });

    it("skips inbound received after the handoff without calling the model", async () => {
      const { deps, responder, evolutionApi } = build({
        store: {
          inbound: {
            conversationStatus: "awaiting_human",
            handoffAt: "2026-10-14T11:59:00.000Z",
            receivedAt: "2026-10-14T12:00:00.000Z",
          },
        },
      });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "awaiting-human" });
      expect(responder.generate).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });

    it("on retry of the triggering message, sends only the pending notice", async () => {
      const { deps, responder, evolutionApi } = build({
        store: { inbound: { conversationStatus: "awaiting_human", handoffAt: INBOUND.receivedAt } },
      });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "handoff", messageId: "msg-out" });
      expect(responder.generate).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).toHaveBeenCalledWith("acme", "5511999998888", AGENT.handoffMessage);
    });

    it("does not resend a notice that already went out", async () => {
      const { deps, evolutionApi } = build({
        store: { inbound: { conversationStatus: "awaiting_human", handoffAt: INBOUND.receivedAt }, answered: true },
      });

      await expect(respondToInboundMessage(deps, JOB)).resolves.toEqual({ status: "skipped", reason: "already-answered" });
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });

    it("leaves a burst message received after the trigger for the human", async () => {
      // Message A triggered the handoff (handoff_at = A.received_at); message B
      // arrived a moment later and was queued behind A's lock.
      const { deps, responder, evolutionApi } = build({
        store: {
          inbound: {
            messageId: "msg-b",
            conversationStatus: "awaiting_human",
            handoffAt: "2026-10-14T12:00:00.000Z",
            receivedAt: "2026-10-14T12:00:00.400Z",
          },
        },
      });

      await expect(respondToInboundMessage(deps, { ...JOB, messageId: "msg-b" })).resolves.toEqual({
        status: "skipped",
        reason: "awaiting-human",
      });
      expect(responder.generate).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });
  });

  describe("CRM identification", () => {
    it("links a phone match once and passes the name to the responder", async () => {
      const { deps, store, responder, customerDirectory } = build({ phoneMatch: { id: "crm-1", name: "Ana Souza" } });

      await respondToInboundMessage(deps, JOB);

      expect(customerDirectory.findByPhone).toHaveBeenCalledWith("5511999998888");
      expect(store.linkCustomer).toHaveBeenCalledWith("conv-1", "crm-1", "phone");
      expect(responder.generate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: { status: "registered", name: "Ana Souza" } }),
      );
    });

    it("uses the stored link instead of searching by phone again", async () => {
      const { deps, store, responder, customerDirectory } = build({
        store: { inbound: { crmClientId: "crm-1", crmLinkVia: "phone" } },
        byId: { id: "crm-1", name: "Ana Souza" },
      });

      await respondToInboundMessage(deps, JOB);

      expect(customerDirectory.findByPhone).not.toHaveBeenCalled();
      expect(customerDirectory.findById).toHaveBeenCalledWith("crm-1");
      expect(store.linkCustomer).not.toHaveBeenCalled();
      expect(responder.generate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: { status: "registered", name: "Ana Souza" } }),
      );
    });

    it("never exposes the stored name on a CPF link", async () => {
      const { deps, responder, customerDirectory } = build({
        store: { inbound: { crmClientId: "crm-1", crmLinkVia: "cpf" } },
        byId: { id: "crm-1", name: "Ana Souza" },
      });

      await respondToInboundMessage(deps, JOB);

      expect(customerDirectory.findById).not.toHaveBeenCalled();
      expect(responder.generate).toHaveBeenCalledWith(expect.objectContaining({ customer: { status: "registered" } }));
    });

    it("treats a linked client deleted from the CRM as unregistered", async () => {
      const { deps, responder } = build({
        store: { inbound: { crmClientId: "crm-gone", crmLinkVia: "created" } },
        byId: null,
      });

      await respondToInboundMessage(deps, JOB);

      expect(responder.generate).toHaveBeenCalledWith(expect.objectContaining({ customer: { status: "unregistered" } }));
    });

    it("persists a link the responder made before sending", async () => {
      const { deps, store, evolutionApi } = build({
        result: { kind: "reply", text: "Cadastro feito!", linkedCustomer: { crmClientId: "crm-new", via: "created" } },
      });

      await respondToInboundMessage(deps, JOB);

      expect(store.linkCustomer).toHaveBeenCalledWith("conv-1", "crm-new", "created");
      expect(store.linkCustomer.mock.invocationCallOrder[0]).toBeLessThan(evolutionApi.sendText.mock.invocationCallOrder[0]);
    });
  });

  describe("lost lock", () => {
    it("aborts before sending a reply", async () => {
      const { deps, evolutionApi, release } = build({ lockLost: true });

      await expect(respondToInboundMessage(deps, JOB)).rejects.toBeInstanceOf(LockLostError);
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("aborts before persisting a handoff", async () => {
      const { deps, store, evolutionApi } = build({ lockLost: true, result: { kind: "handoff", summary: "x" } });

      await expect(respondToInboundMessage(deps, JOB)).rejects.toBeInstanceOf(LockLostError);
      expect(store.markAwaitingHuman).not.toHaveBeenCalled();
      expect(evolutionApi.sendText).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/messaging test -- respondToInboundMessage`
Expected: FAIL (old implementation: queries `deps.supabase`, no handoff/CRM).

- [ ] **Step 4: Narrow `MessagingDeps`**

Replace `packages/messaging/src/deps.ts` with:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";

export interface MessagingDeps {
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
}
```

- [ ] **Step 5: Rewrite `respondToInboundMessage.ts`**

```ts
import type { MessagingDeps } from "./deps";
import type { InboundJobData } from "./inboundQueue";
import type { CustomerContext, HistoryMessage, ResponderPort } from "./responder";
import type { CustomerDirectoryPort } from "./customerDirectory";
import { ConversationBusyError, LockLostError, type ConversationLock, type LockHandle } from "./conversationLock";
import { DEFAULT_HISTORY_LIMIT } from "./conversationHistory";
import { createSupabaseRespondStore, type InboundContext, type RespondStore } from "./respondStore";
import { sendMessage, ConversationNotFoundError } from "./sendMessage";

export type RespondDeps = MessagingDeps & {
  responder: ResponderPort;
  conversationLock: ConversationLock;
  customerDirectory: CustomerDirectoryPort;
  /** Defaults to the Supabase-backed store; tests inject a fake. */
  store?: RespondStore;
  /** How many recent messages the responder sees. Defaults to DEFAULT_HISTORY_LIMIT. */
  historyLimit?: number;
};

export type RespondResult =
  | { status: "sent"; messageId: string }
  | { status: "handoff"; messageId: string }
  | {
      status: "skipped";
      reason: "no-active-agent" | "already-answered" | "responder-declined" | "message-not-found" | "awaiting-human";
    };

const MESSAGE_NOT_FOUND: RespondResult = { status: "skipped", reason: "message-not-found" };

export async function respondToInboundMessage(deps: RespondDeps, job: InboundJobData): Promise<RespondResult> {
  const lock = await deps.conversationLock.acquire(job.conversationId);
  if (!lock) throw new ConversationBusyError(job.conversationId);

  const store = deps.store ?? createSupabaseRespondStore(deps.supabase);

  try {
    const inbound = await store.loadInbound(job.messageId);
    if (!inbound) return MESSAGE_NOT_FOUND;

    if (inbound.conversationStatus === "awaiting_human") {
      if (!isOwedHandoffNotice(inbound)) return { status: "skipped", reason: "awaiting-human" };
      return await sendPendingHandoffNotice(deps, store, lock, inbound);
    }

    const agent = await store.resolveAgent(inbound);
    if (!agent) return { status: "skipped", reason: "no-active-agent" };

    // Retry safety: anything outbound after this message means a previous
    // attempt already answered it. Both timestamps are on the database clock.
    if (await store.hasOutboundAfter(inbound.conversationId, inbound.receivedAt)) {
      return { status: "skipped", reason: "already-answered" };
    }

    const history = await store.loadHistory(inbound.conversationId, deps.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    const customer = await identifyCustomer(deps.customerDirectory, store, inbound);
    const incoming: HistoryMessage = { role: "user", content: inbound.content, createdAt: inbound.createdAt };

    const result = await deps.responder.generate({
      agent,
      history,
      incoming,
      conversationId: inbound.conversationId,
      contactPhone: inbound.contactPhone,
      customer,
    });

    if (result.linkedCustomer) {
      await store.linkCustomer(inbound.conversationId, result.linkedCustomer.crmClientId, result.linkedCustomer.via);
    }

    switch (result.kind) {
      case "decline":
        return { status: "skipped", reason: "responder-declined" };
      case "reply": {
        const messageId = await sendGuarded(deps, lock, inbound.conversationId, result.text);
        return messageId ? { status: "sent", messageId } : MESSAGE_NOT_FOUND;
      }
      case "handoff": {
        // Persist first: if the send fails, the retry finds a pending handoff
        // and only sends the notice — the model is not called again.
        if (lock.isLost()) throw new LockLostError(inbound.conversationId);
        await store.markAwaitingHuman(inbound.conversationId, {
          summary: result.summary,
          handoffAt: inbound.receivedAt,
        });
        const messageId = await sendGuarded(deps, lock, inbound.conversationId, agent.handoffMessage);
        return messageId ? { status: "handoff", messageId } : MESSAGE_NOT_FOUND;
      }
    }
  } finally {
    await lock.release();
  }
}

/**
 * handoff_at is the received_at of the message that triggered the handoff, so
 * that message (and anything received before it) is still owed the notice;
 * anything received later belongs to the human.
 */
function isOwedHandoffNotice(inbound: InboundContext): boolean {
  return inbound.handoffAt !== null && Date.parse(inbound.receivedAt) <= Date.parse(inbound.handoffAt);
}

async function sendPendingHandoffNotice(
  deps: RespondDeps,
  store: RespondStore,
  lock: LockHandle,
  inbound: InboundContext,
): Promise<RespondResult> {
  const agent = await store.resolveAgent(inbound);
  if (!agent) return { status: "skipped", reason: "no-active-agent" };

  if (await store.hasOutboundAfter(inbound.conversationId, inbound.receivedAt)) {
    return { status: "skipped", reason: "already-answered" };
  }

  const messageId = await sendGuarded(deps, lock, inbound.conversationId, agent.handoffMessage);
  return messageId ? { status: "handoff", messageId } : MESSAGE_NOT_FOUND;
}

async function identifyCustomer(
  directory: CustomerDirectoryPort,
  store: RespondStore,
  inbound: InboundContext,
): Promise<CustomerContext> {
  if (inbound.crmClientId) {
    // Anyone can type someone else's CPF: a CPF link never exposes stored data.
    if (inbound.crmLinkVia === "cpf") return { status: "registered" };
    const known = await directory.findById(inbound.crmClientId);
    return known ? { status: "registered", name: known.name } : { status: "unregistered" };
  }

  const match = await directory.findByPhone(inbound.contactPhone);
  if (!match) return { status: "unregistered" };

  await store.linkCustomer(inbound.conversationId, match.id, "phone");
  return { status: "registered", name: match.name };
}

/** Sends unless the lock was lost; null when the conversation vanished. */
async function sendGuarded(
  deps: MessagingDeps,
  lock: LockHandle,
  conversationId: string,
  text: string,
): Promise<string | null> {
  if (lock.isLost()) throw new LockLostError(conversationId);
  try {
    const sent = await sendMessage(deps, { conversationId, text });
    return sent.id;
  } catch (error) {
    // The conversation vanished mid-flight; retrying cannot fix that.
    if (error instanceof ConversationNotFoundError) return null;
    throw error;
  }
}
```

- [ ] **Step 6: Run the messaging suite and type-check**

Run: `pnpm --filter @fmagentes/messaging test` then `pnpm --filter @fmagentes/messaging build`
Expected: all PASS; `tsc` clean. If `tsc` complains that a `switch` lacks a return, it means `ResponderResult` grew a variant — handle it, do not add a default.

- [ ] **Step 7: Check consumers still compile**

Run: `pnpm --filter @fmagentes/api build`
Expected: clean (api only uses `sendMessage`, `MessagingDeps` shape is a subset of `AppDependencies`). `apps/worker` will not compile until Task 10 (it still builds `EchoResponder` deps without `customerDirectory`) — that is expected.

- [ ] **Step 8: Commit**

```bash
git add packages/messaging
git commit -m "feat(messaging): handoff state, CRM identification and lost-lock abort in respond pipeline"
```

---

### Task 5: `packages/agent` scaffold, CPF validation, prompt builder

**Files:**
- Create: `packages/agent/package.json`, `packages/agent/tsconfig.json`, `packages/agent/vitest.config.ts`, `packages/agent/src/index.ts`
- Create: `packages/agent/src/cpf.ts`, `packages/agent/src/buildPrompt.ts`
- Test: `packages/agent/tests/cpf.test.ts`, `packages/agent/tests/buildPrompt.test.ts`

**Interfaces:**
- Consumes: `AgentConfig`, `HistoryMessage`, `CustomerContext` from `@fmagentes/messaging`.
- Produces:
  ```ts
  function normalizeCpf(input: string): string          // digits only
  function isValidCpf(input: string): boolean           // 11 digits, not all equal, check digits ok
  const PLATFORM_INSTRUCTIONS: string
  function customerContextBlock(customer: CustomerContext): string
  function buildPrompt(input: { agent: AgentConfig; history: HistoryMessage[]; customer: CustomerContext }): CoreMessage[]
  ```

- [ ] **Step 1: Scaffold the package**

`packages/agent/package.json`:

```json
{
  "name": "@fmagentes/agent",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fmagentes/messaging": "workspace:*",
    "@fmagentes/shared": "workspace:*",
    "@supabase/supabase-js": "^2.45.4",
    "ai": "^3.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

`packages/agent/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

`packages/agent/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node" },
});
```

`packages/agent/src/index.ts` (grows in later tasks):

```ts
export { normalizeCpf, isValidCpf } from "./cpf";
export { buildPrompt, customerContextBlock, PLATFORM_INSTRUCTIONS } from "./buildPrompt";
```

Run: `pnpm install`
Expected: lockfile updated, `ai` resolved to the already-installed `3.4.33` (check `pnpm --filter @fmagentes/agent list ai`). If a different `ai` version was resolved, pin `"ai": "3.4.33"` and re-run.

- [ ] **Step 2: Write the failing tests**

`packages/agent/tests/cpf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isValidCpf, normalizeCpf } from "../src/cpf";

describe("normalizeCpf", () => {
  it("keeps digits only", () => {
    expect(normalizeCpf(" 529.982.247-25 ")).toBe("52998224725");
  });
});

describe("isValidCpf", () => {
  it.each(["52998224725", "529.982.247-25", "111.444.777-35", "111 444 777 35"])("accepts %s", (cpf) => {
    expect(isValidCpf(cpf)).toBe(true);
  });

  it.each([
    ["wrong first check digit", "52998224715"],
    ["wrong second check digit", "52998224726"],
    ["repeated digits", "111.111.111-11"],
    ["too short", "5299822472"],
    ["too long", "529982247250"],
    ["empty", ""],
    ["letters", "abc.def.ghi-jk"],
  ])("rejects %s", (_label, cpf) => {
    expect(isValidCpf(cpf)).toBe(false);
  });
});
```

`packages/agent/tests/buildPrompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentConfig, HistoryMessage } from "@fmagentes/messaging";
import { buildPrompt, customerContextBlock, PLATFORM_INSTRUCTIONS } from "../src/buildPrompt";

const AGENT: AgentConfig = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  systemPrompt: "Somos a Loja Exemplo. Abrimos das 9h às 18h.",
  handoffMessage: "Já te passo.",
};

const at = (n: number) => `2026-10-14T12:00:0${n}Z`;
const user = (content: string, n = 0): HistoryMessage => ({ role: "user", content, createdAt: at(n) });
const assistant = (content: string, n = 0): HistoryMessage => ({ role: "assistant", content, createdAt: at(n) });

describe("customerContextBlock", () => {
  it("names a registered customer", () => {
    expect(customerContextBlock({ status: "registered", name: "Ana Souza" })).toBe("Cliente cadastrado: Ana Souza.");
  });

  it("omits the name when there is none (CPF link)", () => {
    expect(customerContextBlock({ status: "registered" })).toBe("Cliente cadastrado.");
  });

  it("tells the model to register an unregistered customer", () => {
    expect(customerContextBlock({ status: "unregistered" })).toBe(
      "Cliente SEM cadastro. Antes de prosseguir com o atendimento, peça nome completo, CPF e e-mail e chame cadastrar_cliente.",
    );
  });
});

describe("buildPrompt", () => {
  it("puts the cacheable instructions first and the customer block second", () => {
    const messages = buildPrompt({ agent: AGENT, history: [user("oi")], customer: { status: "unregistered" } });

    expect(messages[0]).toEqual({
      role: "system",
      content: `${PLATFORM_INSTRUCTIONS}\n\n## Instruções do negócio\n${AGENT.systemPrompt}`,
      experimental_providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(messages[1]).toEqual({ role: "system", content: `## Cliente\n${customerContextBlock({ status: "unregistered" })}` });
    expect(messages[2]).toEqual({ role: "user", content: "oi" });
  });

  it("keeps the cached block identical across customers", () => {
    const a = buildPrompt({ agent: AGENT, history: [user("oi")], customer: { status: "unregistered" } });
    const b = buildPrompt({ agent: AGENT, history: [user("oi")], customer: { status: "registered", name: "Ana" } });
    expect(a[0]).toEqual(b[0]);
  });

  it("maps history roles in order", () => {
    const messages = buildPrompt({
      agent: AGENT,
      history: [user("oi", 0), assistant("Olá!", 1), user("qual o horário?", 2)],
      customer: { status: "registered", name: "Ana" },
    });

    expect(messages.slice(2)).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: "Olá!" },
      { role: "user", content: "qual o horário?" },
    ]);
  });

  it("drops assistant messages at the start of a truncated window and blank messages", () => {
    const messages = buildPrompt({
      agent: AGENT,
      history: [assistant("resposta antiga", 0), assistant("outra", 1), user("  ", 2), user("oi", 3), assistant("", 4), user("tudo bem?", 5)],
      customer: { status: "unregistered" },
    });

    expect(messages.slice(2)).toEqual([
      { role: "user", content: "oi" },
      { role: "user", content: "tudo bem?" },
    ]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/agent test`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `cpf.ts`**

```ts
export function normalizeCpf(input: string): string {
  return input.replace(/\D/g, "");
}

/** Brazilian CPF: 11 digits, not all equal, both check digits correct. */
export function isValidCpf(input: string): boolean {
  const digits = normalizeCpf(input);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;

  const checkDigit = (length: number): number => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(digits[i]) * (length + 1 - i);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
}
```

- [ ] **Step 5: Implement `buildPrompt.ts`**

```ts
import type { CoreMessage } from "ai";
import type { AgentConfig, CustomerContext, HistoryMessage } from "@fmagentes/messaging";

export const PLATFORM_INSTRUCTIONS = [
  "Você é um atendente respondendo clientes pelo WhatsApp.",
  "- Escreva mensagens curtas e simples, em texto puro, sem markdown (sem asteriscos, títulos ou listas com marcadores).",
  "- Nunca invente informações que não estejam nas instruções do negócio. Quando não souber, colete os dados básicos e transfira para um atendente humano.",
  "- Se o cliente pedir para falar com um humano, chame a ferramenta transferir_para_humano imediatamente. Se faltarem dados básicos, peça uma única vez; se o cliente insistir, transfira mesmo assim.",
  "- Antes de transferir, colete o que as instruções do negócio pedirem e escreva no campo resumo um resumo do atendimento para o atendente humano.",
  "- Depois de chamar transferir_para_humano, não escreva mais nada: a mensagem de transferência é enviada automaticamente.",
].join("\n");

export function customerContextBlock(customer: CustomerContext): string {
  if (customer.status === "unregistered") {
    return "Cliente SEM cadastro. Antes de prosseguir com o atendimento, peça nome completo, CPF e e-mail e chame cadastrar_cliente.";
  }
  return customer.name ? `Cliente cadastrado: ${customer.name}.` : "Cliente cadastrado.";
}

/**
 * Two system messages: the first is identical for every conversation of an
 * agent (Anthropic caches it), the second carries the per-customer context.
 * History is trimmed to what providers accept: it must start with the user and
 * contain no blank text.
 */
export function buildPrompt(input: {
  agent: AgentConfig;
  history: HistoryMessage[];
  customer: CustomerContext;
}): CoreMessage[] {
  const nonBlank = input.history.filter((message) => message.content.trim().length > 0);
  const firstUser = nonBlank.findIndex((message) => message.role === "user");
  const history = firstUser === -1 ? [] : nonBlank.slice(firstUser);

  return [
    {
      role: "system",
      content: `${PLATFORM_INSTRUCTIONS}\n\n## Instruções do negócio\n${input.agent.systemPrompt}`,
      experimental_providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    { role: "system", content: `## Cliente\n${customerContextBlock(input.customer)}` },
    // Spelled out per role: CoreMessage is a discriminated union, so a
    // `role: "user" | "assistant"` object literal would not type-check.
    ...history.map(
      (message): CoreMessage =>
        message.role === "user"
          ? { role: "user", content: message.content }
          : { role: "assistant", content: message.content },
    ),
  ];
}
```

- [ ] **Step 6: Run tests and type-check**

Run: `pnpm --filter @fmagentes/agent test` then `pnpm --filter @fmagentes/agent build`
Expected: PASS; `tsc` clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent pnpm-lock.yaml
git commit -m "feat(agent): new package with CPF validation and prompt builder"
```

---

### Task 6: CRM adapter (`CrmPort` + Supabase)

**Files:**
- Create: `packages/agent/src/crm/CrmPort.ts`, `packages/agent/src/crm/phoneMatch.ts`, `packages/agent/src/crm/supabaseCrm.ts`
- Create: `packages/agent/tests/support/supabaseMock.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/tests/phoneMatch.test.ts`, `packages/agent/tests/supabaseCrm.test.ts`

**Interfaces:**
- Consumes: `normalizeCpf` (Task 5).
- Produces:
  ```ts
  interface CrmClient { id: string; name: string; phone: string | null; notes: string | null }
  interface NewCrmClient { name: string; cpf: string; email: string; phone: string }
  interface CrmPort {
    findByPhone(phone: string): Promise<CrmClient | null>;
    findById(id: string): Promise<CrmClient | null>;
    findByCpf(cpf: string): Promise<CrmClient | null>;
    create(input: NewCrmClient): Promise<CrmClient>;      // throws CrmCpfTakenError on unique violation
    attachPhone(clientId: string, phone: string): Promise<void>;
  }
  class CrmCpfTakenError extends Error
  const AGENT_CREATED_NOTE = "Cadastrado pelo agente WhatsApp"
  function phoneMatchSuffixes(whatsappPhone: string): string[]
  function createSupabaseCrm(supabase: SupabaseClient, options: { agentUserId: string; warn?: (message: string) => void }): CrmPort
  ```
  `CrmPort` structurally satisfies messaging's `CustomerDirectoryPort`.

- [ ] **Step 1: Write the test support mock**

`packages/agent/tests/support/supabaseMock.ts` (same shape as messaging's, with the extra filter ops this adapter uses):

```ts
import { vi } from "vitest";

export type TableCall = { op: string; args: unknown[] }[];
export type Handler = (calls: TableCall) => { data: unknown; error: unknown };

/** Chainable Supabase mock; each `from()` records its call chain for the handler. */
export function createSupabaseMock(handlers: Record<string, Handler>) {
  const from = vi.fn((table: string) => {
    const calls: TableCall = [];
    const result = () => handlers[table]?.(calls) ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "insert", "update", "eq", "or", "limit"]) {
      chain[op] = vi.fn((...args: unknown[]) => {
        calls.push({ op, args });
        return chain;
      });
    }
    chain.single = vi.fn(async () => result());
    chain.maybeSingle = vi.fn(async () => result());
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
    return chain;
  });
  return { from };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/agent/tests/phoneMatch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { phoneMatchSuffixes } from "../src/crm/phoneMatch";

describe("phoneMatchSuffixes", () => {
  it("strips 55 and adds the variant without the ninth digit", () => {
    expect(phoneMatchSuffixes("5511999998888")).toEqual(["11999998888", "1199998888"]);
  });

  it("adds the ninth digit to an old 8-digit mobile", () => {
    expect(phoneMatchSuffixes("551199998888")).toEqual(["1199998888", "11999998888"]);
  });

  it("does not invent a variant when the 11-digit number's third digit is not 9", () => {
    expect(phoneMatchSuffixes("5511333334444")).toEqual(["11333334444"]);
  });

  it("keeps a foreign number whole", () => {
    expect(phoneMatchSuffixes("14155552671")).toEqual(["14155552671"]);
  });

  it("refuses numbers too short to match safely", () => {
    expect(phoneMatchSuffixes("5599998888")).toEqual([]);
    expect(phoneMatchSuffixes("12345")).toEqual([]);
    expect(phoneMatchSuffixes("")).toEqual([]);
  });

  it("ignores formatting", () => {
    expect(phoneMatchSuffixes("+55 (11) 99999-8888")).toEqual(["11999998888", "1199998888"]);
  });
});
```

`packages/agent/tests/supabaseCrm.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AGENT_CREATED_NOTE, CrmCpfTakenError, createSupabaseCrm } from "../src/crm/supabaseCrm";
import { createSupabaseMock, type Handler, type TableCall } from "./support/supabaseMock";

const AGENT_USER = "11111111-1111-1111-1111-111111111111";
const ANA = { id: "crm-1", name: "Ana Souza", phone: "(11) 99999-8888", notes: null };

function crmWith(clients: Handler, warn = vi.fn()) {
  const supabase = createSupabaseMock({ clients });
  return { crm: createSupabaseCrm(supabase as never, { agentUserId: AGENT_USER, warn }), supabase, warn };
}

describe("createSupabaseCrm", () => {
  describe("findByPhone", () => {
    it("matches phone_digits by suffix, with and without the ninth digit", async () => {
      let recorded: TableCall = [];
      const { crm } = crmWith((calls) => {
        recorded = calls;
        return { data: [ANA], error: null };
      });

      await expect(crm.findByPhone("5511999998888")).resolves.toEqual(ANA);
      expect(recorded).toContainEqual({ op: "or", args: ["phone_digits.like.*11999998888,phone_digits.like.*1199998888"] });
      expect(recorded).toContainEqual({ op: "limit", args: [2] });
    });

    it("treats more than one match as not found and warns without the phone", async () => {
      const { crm, warn } = crmWith(() => ({ data: [ANA, { ...ANA, id: "crm-2" }], error: null }));

      await expect(crm.findByPhone("5511999998888")).resolves.toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).not.toContain("99999");
    });

    it("returns null without querying for a number too short to match", async () => {
      const { crm, supabase } = crmWith(() => ({ data: [ANA], error: null }));

      await expect(crm.findByPhone("12345")).resolves.toBeNull();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it("returns null when nobody matches", async () => {
      const { crm } = crmWith(() => ({ data: [], error: null }));
      await expect(crm.findByPhone("5511999998888")).resolves.toBeNull();
    });

    it("throws when the CRM query fails", async () => {
      const { crm } = crmWith(() => ({ data: null, error: { message: "crm down" } }));
      await expect(crm.findByPhone("5511999998888")).rejects.toThrow("crm down");
    });
  });

  it("finds by CPF using digits only", async () => {
    let recorded: TableCall = [];
    const { crm } = crmWith((calls) => {
      recorded = calls;
      return { data: ANA, error: null };
    });

    await expect(crm.findByCpf("529.982.247-25")).resolves.toEqual(ANA);
    expect(recorded).toContainEqual({ op: "eq", args: ["cpf", "52998224725"] });
  });

  describe("create", () => {
    it("creates the client owned by the designated user with the origin note", async () => {
      let recorded: TableCall = [];
      const { crm } = crmWith((calls) => {
        recorded = calls;
        return { data: { id: "crm-new", name: "Bruno", phone: "5511988887777", notes: AGENT_CREATED_NOTE }, error: null };
      });

      await expect(
        crm.create({ name: "Bruno", cpf: "52998224725", email: "bruno@example.com", phone: "5511988887777" }),
      ).resolves.toMatchObject({ id: "crm-new" });
      expect(recorded).toContainEqual({
        op: "insert",
        args: [
          {
            user_id: AGENT_USER,
            name: "Bruno",
            cpf: "52998224725",
            email: "bruno@example.com",
            phone: "5511988887777",
            notes: "Cadastrado pelo agente WhatsApp",
          },
        ],
      });
    });

    it("raises CrmCpfTakenError on a CPF unique violation", async () => {
      const { crm } = crmWith(() => ({ data: null, error: { code: "23505", message: "duplicate key" } }));
      await expect(
        crm.create({ name: "Bruno", cpf: "52998224725", email: "b@example.com", phone: "55119" }),
      ).rejects.toBeInstanceOf(CrmCpfTakenError);
    });
  });

  describe("attachPhone", () => {
    function attachScenario(current: { phone: string | null; notes: string | null }) {
      const updates: unknown[] = [];
      const { crm } = crmWith((calls) => {
        const update = calls.find((c) => c.op === "update");
        if (update) {
          updates.push(update.args[0]);
          return { data: null, error: null };
        }
        return { data: { id: "crm-1", name: "Ana", ...current }, error: null };
      });
      return { crm, updates };
    }

    it("fills an empty phone", async () => {
      const { crm, updates } = attachScenario({ phone: "  ", notes: null });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([{ phone: "5511988887777" }]);
    });

    it("appends a note when the client already has another phone", async () => {
      const { crm, updates } = attachScenario({ phone: "(11) 3333-4444", notes: "VIP" });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([{ notes: "VIP\nOutro WhatsApp: 5511988887777" }]);
    });

    it("does nothing when the note is already there (retry)", async () => {
      const { crm, updates } = attachScenario({ phone: "(11) 3333-4444", notes: "Outro WhatsApp: 5511988887777" });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([]);
    });

    it("does nothing when the phone is already the client's", async () => {
      const { crm, updates } = attachScenario({ phone: "+55 11 98888-7777", notes: null });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([]);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/agent test -- phoneMatch supabaseCrm`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `CrmPort.ts`**

```ts
export interface CrmClient {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
}

export interface NewCrmClient {
  name: string;
  /** Digits only. */
  cpf: string;
  email: string;
  phone: string;
}

/**
 * The agent's view of the CRM. Today a Supabase adapter; an HTTP API can
 * replace it without touching the tools.
 */
export interface CrmPort {
  /** null when nobody, or more than one client, matches. */
  findByPhone(phone: string): Promise<CrmClient | null>;
  findById(id: string): Promise<CrmClient | null>;
  findByCpf(cpf: string): Promise<CrmClient | null>;
  /** Throws CrmCpfTakenError when the CPF already exists. */
  create(input: NewCrmClient): Promise<CrmClient>;
  /** Fills an empty phone, or notes the extra number; never overwrites. */
  attachPhone(clientId: string, phone: string): Promise<void>;
}

export class CrmCpfTakenError extends Error {
  constructor() {
    super("CPF already registered in the CRM");
    this.name = "CrmCpfTakenError";
  }
}
```

- [ ] **Step 5: Implement `phoneMatch.ts`**

```ts
const MIN_NATIONAL_DIGITS = 10;

/**
 * Suffixes a CRM `phone_digits` may end with for this WhatsApp number.
 * WhatsApp gives 55 + DDD + number; CRM phones are typed by hand, with or
 * without country code and with or without the mobile ninth digit. Too-short
 * numbers return [] so a tiny suffix never matches half the CRM.
 */
export function phoneMatchSuffixes(whatsappPhone: string): string[] {
  const digits = whatsappPhone.replace(/\D/g, "");
  const isBrazilian = digits.startsWith("55") && digits.length >= 12;
  const national = isBrazilian ? digits.slice(2) : digits;
  if (national.length < MIN_NATIONAL_DIGITS) return [];
  if (!isBrazilian) return [national];

  const ddd = national.slice(0, 2);
  if (national.length === 11 && national[2] === "9") return [national, ddd + national.slice(3)];
  if (national.length === 10) return [national, `${ddd}9${national.slice(2)}`];
  return [national];
}
```

- [ ] **Step 6: Implement `supabaseCrm.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCpf } from "../cpf";
import { CrmCpfTakenError, type CrmClient, type CrmPort, type NewCrmClient } from "./CrmPort";
import { phoneMatchSuffixes } from "./phoneMatch";

export { CrmCpfTakenError } from "./CrmPort";

export const AGENT_CREATED_NOTE = "Cadastrado pelo agente WhatsApp";

const COLUMNS = "id, name, phone, notes";
const UNIQUE_VIOLATION = "23505";

function throwIfError(error: unknown): void {
  if (error) {
    const message =
      typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "CRM error";
    throw new Error(message);
  }
}

const digitsOf = (value: string) => value.replace(/\D/g, "");

/**
 * Direct access to the CRM's Supabase project with its service key (bypasses
 * the CRM's RLS by design — runs server-side only). Never writes phone_digits
 * or search_vector: both are generated columns.
 */
export function createSupabaseCrm(
  supabase: SupabaseClient,
  options: { agentUserId: string; warn?: (message: string) => void },
): CrmPort {
  const warn = options.warn ?? ((message: string) => console.warn(message));

  async function findById(id: string): Promise<CrmClient | null> {
    const result = await supabase.from("clients").select(COLUMNS).eq("id", id).maybeSingle();
    throwIfError(result.error);
    return result.data as CrmClient | null;
  }

  return {
    async findByPhone(phone) {
      const suffixes = phoneMatchSuffixes(phone);
      if (suffixes.length === 0) return null;

      const result = await supabase
        .from("clients")
        .select(COLUMNS)
        .or(suffixes.map((suffix) => `phone_digits.like.*${suffix}`).join(","))
        .limit(2);
      throwIfError(result.error);

      const rows = (result.data as CrmClient[] | null) ?? [];
      if (rows.length > 1) {
        warn(`[crm] phone matched ${rows.length} clients (${rows.map((r) => r.id).join(", ")}); treating as not found`);
        return null;
      }
      return rows[0] ?? null;
    },

    findById,

    async findByCpf(cpf) {
      const result = await supabase.from("clients").select(COLUMNS).eq("cpf", normalizeCpf(cpf)).maybeSingle();
      throwIfError(result.error);
      return result.data as CrmClient | null;
    },

    async create(input: NewCrmClient) {
      const result = await supabase
        .from("clients")
        .insert({
          user_id: options.agentUserId,
          name: input.name,
          cpf: input.cpf,
          email: input.email,
          phone: input.phone,
          notes: AGENT_CREATED_NOTE,
        })
        .select(COLUMNS)
        .single();
      if (result.error && (result.error as { code?: string }).code === UNIQUE_VIOLATION) throw new CrmCpfTakenError();
      throwIfError(result.error);
      return result.data as CrmClient;
    },

    async attachPhone(clientId, phone) {
      const current = await findById(clientId);
      if (!current) throw new Error(`CRM client not found: ${clientId}`);

      const phoneDigits = digitsOf(phone);
      let patch: Partial<Pick<CrmClient, "phone" | "notes">> | null = null;

      if (!current.phone?.trim()) {
        patch = { phone };
      } else if (digitsOf(current.phone) !== phoneDigits && !current.notes?.includes(phoneDigits)) {
        const line = `Outro WhatsApp: ${phone}`;
        patch = { notes: current.notes ? `${current.notes}\n${line}` : line };
      }
      if (!patch) return;

      const result = await supabase.from("clients").update(patch).eq("id", clientId);
      throwIfError(result.error);
    },
  };
}
```

Note: the "already the client's" check compares full digit strings; `"+55 11 98888-7777"` → `5511988887777` equals the WhatsApp digits, so the test passes. A CRM phone typed without `55` falls through to the notes path — acceptable (the note is harmless and the phone lookup would have matched that client first anyway).

- [ ] **Step 7: Export**

Append to `packages/agent/src/index.ts`:

```ts
export type { CrmClient, CrmPort, NewCrmClient } from "./crm/CrmPort";
export { CrmCpfTakenError, AGENT_CREATED_NOTE, createSupabaseCrm } from "./crm/supabaseCrm";
export { phoneMatchSuffixes } from "./crm/phoneMatch";
```

- [ ] **Step 8: Run tests and type-check**

Run: `pnpm --filter @fmagentes/agent test` then `pnpm --filter @fmagentes/agent build`
Expected: PASS; `tsc` clean.

- [ ] **Step 9: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): Supabase CRM adapter with phone matching and safe phone attach"
```

---

### Task 7: Tools — `transferir_para_humano` and `cadastrar_cliente`

**Files:**
- Create: `packages/agent/src/tools/handoff.ts`, `packages/agent/src/tools/registerCustomer.ts`
- Create: `packages/agent/tests/support/fakeCrm.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/tests/registerCustomer.test.ts`

**Interfaces:**
- Consumes: `CrmPort`, `CrmCpfTakenError` (Task 6); `isValidCpf`, `normalizeCpf` (Task 5); `LinkedCustomer` from messaging.
- Produces:
  ```ts
  const HANDOFF_TOOL_NAME = "transferir_para_humano"
  const handoffTool                      // tool({ parameters: { resumo: string } }) — no execute
  const REGISTER_TOOL_NAME = "cadastrar_cliente"
  interface RegistrationOutcome { linked?: LinkedCustomer }
  function registerCustomer(crm: CrmPort, contactPhone: string, args: { nome: string; cpf: string; email: string }, outcome: RegistrationOutcome): Promise<string>
  function createRegisterCustomerTool(crm: CrmPort, contactPhone: string, outcome: RegistrationOutcome)   // tool with execute → registerCustomer
  ```

- [ ] **Step 1: Write the fake CRM**

`packages/agent/tests/support/fakeCrm.ts`:

```ts
import { vi } from "vitest";
import type { CrmClient, CrmPort, NewCrmClient } from "../../src/crm/CrmPort";

export function createFakeCrm(seed: { byCpf?: CrmClient | null; created?: CrmClient } = {}) {
  return {
    findByPhone: vi.fn(async (_phone: string): Promise<CrmClient | null> => null),
    findById: vi.fn(async (_id: string): Promise<CrmClient | null> => null),
    findByCpf: vi.fn(async (_cpf: string): Promise<CrmClient | null> => seed.byCpf ?? null),
    create: vi.fn(
      async (input: NewCrmClient): Promise<CrmClient> =>
        seed.created ?? { id: "crm-new", name: input.name, phone: input.phone, notes: "Cadastrado pelo agente WhatsApp" },
    ),
    attachPhone: vi.fn(async (_clientId: string, _phone: string) => {}),
  } satisfies CrmPort;
}
```

- [ ] **Step 2: Write the failing tests**

`packages/agent/tests/registerCustomer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { registerCustomer, type RegistrationOutcome } from "../src/tools/registerCustomer";
import { CrmCpfTakenError } from "../src/crm/CrmPort";
import { createFakeCrm } from "./support/fakeCrm";

const PHONE = "5511988887777";
const VALID = { nome: " Bruno Lima ", cpf: "529.982.247-25", email: " Bruno@Example.com " };
const EXISTING = { id: "crm-1", name: "Ana Souza", phone: "11 3333-4444", notes: "VIP, e-mail ana@example.com" };

describe("registerCustomer", () => {
  it.each([
    ["blank name", { ...VALID, nome: "  " }, /nome/i],
    ["invalid CPF", { ...VALID, cpf: "111.111.111-11" }, /CPF inválido/],
    ["invalid e-mail", { ...VALID, email: "bruno@" }, /e-mail inválido/],
  ])("rejects %s without touching the CRM", async (_label, args, message) => {
    const crm = createFakeCrm();
    const outcome: RegistrationOutcome = {};

    await expect(registerCustomer(crm, PHONE, args, outcome)).resolves.toMatch(message);
    expect(crm.findByCpf).not.toHaveBeenCalled();
    expect(crm.create).not.toHaveBeenCalled();
    expect(outcome.linked).toBeUndefined();
  });

  it("creates a new client with normalised data", async () => {
    const crm = createFakeCrm();
    const outcome: RegistrationOutcome = {};

    await expect(registerCustomer(crm, PHONE, VALID, outcome)).resolves.toMatch(/criado/i);
    expect(crm.findByCpf).toHaveBeenCalledWith("52998224725");
    expect(crm.create).toHaveBeenCalledWith({
      name: "Bruno Lima",
      cpf: "52998224725",
      email: "bruno@example.com",
      phone: PHONE,
    });
    expect(outcome.linked).toEqual({ crmClientId: "crm-new", via: "created" });
  });

  it("links an existing CPF, attaches the phone and reveals nothing stored", async () => {
    const crm = createFakeCrm({ byCpf: EXISTING });
    const outcome: RegistrationOutcome = {};

    const answer = await registerCustomer(crm, PHONE, VALID, outcome);

    expect(answer).toMatch(/vinculado/i);
    expect(answer).not.toContain("Ana");
    expect(answer).not.toContain("ana@example.com");
    expect(answer).not.toContain("3333");
    expect(crm.attachPhone).toHaveBeenCalledWith("crm-1", PHONE);
    expect(crm.create).not.toHaveBeenCalled();
    expect(outcome.linked).toEqual({ crmClientId: "crm-1", via: "cpf" });
  });

  it("links instead of failing when another process created the CPF first", async () => {
    const crm = createFakeCrm();
    crm.create.mockRejectedValueOnce(new CrmCpfTakenError());
    crm.findByCpf.mockResolvedValueOnce(null).mockResolvedValueOnce(EXISTING);
    const outcome: RegistrationOutcome = {};

    await expect(registerCustomer(crm, PHONE, VALID, outcome)).resolves.toMatch(/vinculado/i);
    expect(outcome.linked).toEqual({ crmClientId: "crm-1", via: "cpf" });
  });

  it("throws when the CRM is unavailable so the job retries", async () => {
    const crm = createFakeCrm();
    crm.findByCpf.mockRejectedValueOnce(new Error("crm down"));

    await expect(registerCustomer(crm, PHONE, VALID, {})).rejects.toThrow("crm down");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/agent test -- registerCustomer`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `tools/handoff.ts`**

```ts
import { tool } from "ai";
import { z } from "zod";

export const HANDOFF_TOOL_NAME = "transferir_para_humano";

/**
 * No `execute` on purpose: calling it ends the generateText loop, and the
 * responder turns the call into a `handoff` result.
 */
export const handoffTool = tool({
  description:
    "Transfere a conversa para um atendente humano. Use quando o cliente pedir um humano ou quando você não souber responder. Depois de chamar, não escreva mais nada.",
  parameters: z.object({
    resumo: z
      .string()
      .describe("Resumo para o atendente humano: quem é o cliente, o que ele quer e os dados já coletados."),
  }),
});
```

- [ ] **Step 5: Implement `tools/registerCustomer.ts`**

```ts
import { tool } from "ai";
import { z } from "zod";
import type { LinkedCustomer } from "@fmagentes/messaging";
import { isValidCpf, normalizeCpf } from "../cpf";
import { CrmCpfTakenError, type CrmPort } from "../crm/CrmPort";

export const REGISTER_TOOL_NAME = "cadastrar_cliente";

/** Filled by the tool during the call; the responder reports it to messaging. */
export interface RegistrationOutcome {
  linked?: LinkedCustomer;
}

export interface RegistrationArgs {
  nome: string;
  cpf: string;
  email: string;
}

const emailSchema = z.string().email();

/**
 * Validates, then links an existing CPF or creates the client. Invalid input
 * returns an error string so the model asks the customer again. A CPF link
 * returns no stored data: anyone can type someone else's CPF.
 */
export async function registerCustomer(
  crm: CrmPort,
  contactPhone: string,
  args: RegistrationArgs,
  outcome: RegistrationOutcome,
): Promise<string> {
  const name = args.nome.trim();
  if (name.length === 0) return "Erro: nome vazio. Peça o nome completo ao cliente.";
  if (!isValidCpf(args.cpf)) return "Erro: CPF inválido. Peça ao cliente para conferir e enviar o CPF novamente.";
  const email = args.email.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) {
    return "Erro: e-mail inválido. Peça ao cliente para conferir e enviar o e-mail novamente.";
  }
  const cpf = normalizeCpf(args.cpf);

  const link = async (clientId: string) => {
    await crm.attachPhone(clientId, contactPhone);
    outcome.linked = { crmClientId: clientId, via: "cpf" };
    return "Cadastro vinculado: este CPF já tinha cadastro. Continue o atendimento sem citar dados do cadastro.";
  };

  const existing = await crm.findByCpf(cpf);
  if (existing) return link(existing.id);

  try {
    const created = await crm.create({ name, cpf, email, phone: contactPhone });
    outcome.linked = { crmClientId: created.id, via: "created" };
    return "Cadastro criado com sucesso.";
  } catch (error) {
    if (!(error instanceof CrmCpfTakenError)) throw error;
    // Someone registered this CPF between our lookup and our insert.
    const raced = await crm.findByCpf(cpf);
    if (!raced) throw error;
    return link(raced.id);
  }
}

export function createRegisterCustomerTool(crm: CrmPort, contactPhone: string, outcome: RegistrationOutcome) {
  return tool({
    description:
      "Cadastra o cliente no CRM. Chame somente quando tiver nome completo, CPF e e-mail informados pelo cliente.",
    parameters: z.object({
      nome: z.string().describe("Nome completo do cliente"),
      cpf: z.string().describe("CPF do cliente, com ou sem pontuação"),
      email: z.string().describe("E-mail do cliente"),
    }),
    execute: (args) => registerCustomer(crm, contactPhone, args, outcome),
  });
}
```

- [ ] **Step 6: Export**

Append to `packages/agent/src/index.ts`:

```ts
export { HANDOFF_TOOL_NAME, handoffTool } from "./tools/handoff";
export {
  REGISTER_TOOL_NAME,
  createRegisterCustomerTool,
  registerCustomer,
  type RegistrationOutcome,
} from "./tools/registerCustomer";
```

- [ ] **Step 7: Run tests and type-check**

Run: `pnpm --filter @fmagentes/agent test` then `pnpm --filter @fmagentes/agent build`
Expected: PASS; `tsc` clean.

- [ ] **Step 8: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): handoff and customer-registration tools"
```

---

### Task 8: `LlmResponder` and `getModel` cache control

**Files:**
- Modify: `packages/shared/src/llm.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/tests/llm.test.ts`
- Create: `packages/agent/src/LlmResponder.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/tests/LlmResponder.test.ts`

**Interfaces:**
- Consumes: `buildPrompt` (5), `CrmPort` (6), tools + `RegistrationOutcome` (7), `ResponderPort`, `ResponderResult`, `ResponderConfigurationError` (3).
- Produces:
  ```ts
  // shared
  interface ModelOptions { cacheControl?: boolean }
  function getModel(config: LlmConfig, provider: LlmProvider, modelName: string, options?: ModelOptions): LanguageModel
  // agent
  const DEFAULT_LLM_TIMEOUT_MS = 45_000
  const MAX_STEPS = 3
  interface LlmResponderOptions {
    llm: LlmConfig;
    crm: CrmPort;
    timeoutMs?: number;
    /** Test seam; production builds models with getModel. */
    createModel?: (provider: LlmProvider, model: string) => LanguageModel;
  }
  class LlmResponder implements ResponderPort { constructor(options: LlmResponderOptions) }
  ```

- [ ] **Step 1: Write the failing `getModel` tests**

In `packages/shared/tests/llm.test.ts`, change the Anthropic assertion and add a test:

```ts
  it("returns an Anthropic model when provider is anthropic", () => {
    const model = getModel(config, "anthropic", "claude-opus-4-8");

    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: "a-key" });
    expect(anthropicModelFactory).toHaveBeenCalledWith("claude-opus-4-8", { cacheControl: false });
    expect(model).toBe("anthropic-model");
  });

  it("enables Anthropic prompt caching when asked", () => {
    getModel(config, "anthropic", "claude-haiku-4-5", { cacheControl: true });
    expect(anthropicModelFactory).toHaveBeenCalledWith("claude-haiku-4-5", { cacheControl: true });
  });
```

Run: `pnpm --filter @fmagentes/shared test -- llm` → FAIL.

- [ ] **Step 2: Implement the option**

Replace `packages/shared/src/llm.ts` with:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type LlmProvider = "anthropic" | "openai";

export interface LlmConfig {
  anthropicApiKey: string;
  openaiApiKey: string;
}

export interface ModelOptions {
  /** Anthropic only: honour cacheControl metadata on prompt messages. */
  cacheControl?: boolean;
}

export function getModel(
  config: LlmConfig,
  provider: LlmProvider,
  modelName: string,
  options: ModelOptions = {},
): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: config.anthropicApiKey })(modelName, {
        cacheControl: options.cacheControl ?? false,
      });
    case "openai":
      return createOpenAI({ apiKey: config.openaiApiKey })(modelName);
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported LLM provider: ${exhaustiveCheck}`);
    }
  }
}
```

In `packages/shared/src/index.ts` change the llm export to:

```ts
export { getModel, type LlmConfig, type LlmProvider, type ModelOptions } from "./llm";
```

Run: `pnpm --filter @fmagentes/shared test` and `pnpm --filter @fmagentes/shared build` → PASS.

- [ ] **Step 3: Write the failing `LlmResponder` tests**

`packages/agent/tests/LlmResponder.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV1 } from "ai/test";
import { APICallError } from "ai";
import type { LanguageModelV1CallOptions } from "ai";
import { ResponderConfigurationError, type ResponderInput } from "@fmagentes/messaging";
import { LlmResponder } from "../src/LlmResponder";
import { createFakeCrm } from "./support/fakeCrm";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV1["doGenerate"]>>;

const base = {
  rawCall: { rawPrompt: null, rawSettings: {} },
  usage: { promptTokens: 10, completionTokens: 5 },
} as const;

const text = (value: string): GenerateResult => ({ ...base, finishReason: "stop", text: value });

const toolCall = (toolName: string, args: object, id = "call-1"): GenerateResult => ({
  ...base,
  finishReason: "tool-calls",
  toolCalls: [{ toolCallType: "function", toolCallId: id, toolName, args: JSON.stringify(args) }],
});

/** A model that answers each step with the next scripted response. */
function scripted(...responses: GenerateResult[]) {
  const calls: LanguageModelV1CallOptions[] = [];
  const model = new MockLanguageModelV1({
    doGenerate: async (options) => {
      calls.push(options);
      const next = responses[calls.length - 1];
      if (!next) throw new Error(`unexpected step ${calls.length}`);
      return next;
    },
  });
  return { model, calls };
}

const INPUT: ResponderInput = {
  agent: {
    id: "agent-1",
    name: "Atendente",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    systemPrompt: "Somos a Loja Exemplo.",
    handoffMessage: "Já te passo.",
  },
  history: [{ role: "user", content: "oi", createdAt: "2026-10-14T12:00:00Z" }],
  incoming: { role: "user", content: "oi", createdAt: "2026-10-14T12:00:00Z" },
  conversationId: "conv-1",
  contactPhone: "5511988887777",
  customer: { status: "unregistered" },
};

function responderWith(model: MockLanguageModelV1, overrides: { crm?: ReturnType<typeof createFakeCrm>; timeoutMs?: number; keys?: Partial<{ anthropicApiKey: string; openaiApiKey: string }> } = {}) {
  const createModel = vi.fn(() => model);
  const responder = new LlmResponder({
    llm: { anthropicApiKey: "a-key", openaiApiKey: "o-key", ...overrides.keys },
    crm: overrides.crm ?? createFakeCrm(),
    timeoutMs: overrides.timeoutMs,
    createModel,
  });
  return { responder, createModel };
}

describe("LlmResponder", () => {
  it("returns the model's text as a reply", async () => {
    const { model } = scripted(text("  Olá! Como posso ajudar?  "));
    const { responder, createModel } = responderWith(model);

    await expect(responder.generate(INPUT)).resolves.toEqual({ kind: "reply", text: "Olá! Como posso ajudar?" });
    expect(createModel).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
  });

  it("sends the built prompt", async () => {
    const { model, calls } = scripted(text("Olá!"));
    const { responder } = responderWith(model);

    await responder.generate(INPUT);

    const prompt = calls[0].prompt;
    expect(prompt[0]).toMatchObject({ role: "system" });
    expect((prompt[0] as { content: string }).content).toContain("Somos a Loja Exemplo.");
    expect((prompt[1] as { content: string }).content).toContain("Cliente SEM cadastro");
    expect(prompt[2]).toMatchObject({ role: "user" });
  });

  it("offers both tools to an unregistered customer and only handoff to a registered one", async () => {
    const toolNames = (options: LanguageModelV1CallOptions) =>
      options.mode.type === "regular" ? (options.mode.tools ?? []).map((t) => t.name).sort() : [];

    const first = scripted(text("ok"));
    await responderWith(first.model).responder.generate(INPUT);
    expect(toolNames(first.calls[0])).toEqual(["cadastrar_cliente", "transferir_para_humano"]);

    const second = scripted(text("ok"));
    await responderWith(second.model).responder.generate({ ...INPUT, customer: { status: "registered", name: "Ana" } });
    expect(toolNames(second.calls[0])).toEqual(["transferir_para_humano"]);
  });

  it("turns a handoff tool call into a handoff with its summary", async () => {
    const { model, calls } = scripted(toolCall("transferir_para_humano", { resumo: "Quer orçamento de casco" }));
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).resolves.toEqual({ kind: "handoff", summary: "Quer orçamento de casco" });
    expect(calls).toHaveLength(1); // no execute → the loop stops
  });

  it("lets a handoff win over text in the same step", async () => {
    const { model } = scripted({
      ...toolCall("transferir_para_humano", { resumo: "Pediu humano" }),
      text: "Vou transferir você agora!",
    });
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).resolves.toEqual({ kind: "handoff", summary: "Pediu humano" });
  });

  it("declines when the final text is blank", async () => {
    const { model } = scripted(text("   "));
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).resolves.toEqual({ kind: "decline" });
  });

  it("registers through the tool and reports the link with the reply", async () => {
    const crm = createFakeCrm();
    const { model, calls } = scripted(
      toolCall("cadastrar_cliente", { nome: "Bruno Lima", cpf: "529.982.247-25", email: "bruno@example.com" }),
      text("Pronto, cadastro feito! Em que posso ajudar?"),
    );
    const { responder } = responderWith(model, { crm });

    await expect(responder.generate(INPUT)).resolves.toEqual({
      kind: "reply",
      text: "Pronto, cadastro feito! Em que posso ajudar?",
      linkedCustomer: { crmClientId: "crm-new", via: "created" },
    });
    expect(crm.create).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
  });

  it("rethrows a transient provider error untouched so BullMQ retries", async () => {
    const rateLimited = new APICallError({
      message: "rate limited",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
    });
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        throw rateLimited;
      },
    });
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).rejects.toBe(rateLimited);
  });

  it.each([401, 403, 404])("treats HTTP %i as a configuration error", async (statusCode) => {
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        throw new APICallError({ message: "nope", url: "u", requestBodyValues: {}, statusCode, isRetryable: false });
      },
    });
    const { responder } = responderWith(model);

    const error = await responder.generate(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponderConfigurationError);
    expect((error as ResponderConfigurationError).agentId).toBe("agent-1");
  });

  it("rejects an unknown provider before calling any model", async () => {
    const { model, calls } = scripted(text("never"));
    const { responder, createModel } = responderWith(model);

    await expect(
      responder.generate({ ...INPUT, agent: { ...INPUT.agent, provider: "echo" } }),
    ).rejects.toBeInstanceOf(ResponderConfigurationError);
    expect(createModel).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("rejects a provider whose API key is not configured", async () => {
    const { model } = scripted(text("never"));
    const { responder } = responderWith(model, { keys: { openaiApiKey: "" } });

    await expect(
      responder.generate({ ...INPUT, agent: { ...INPUT.agent, provider: "openai", model: "gpt-4o" } }),
    ).rejects.toBeInstanceOf(ResponderConfigurationError);
  });

  it("aborts a call that exceeds the timeout as a transient error", async () => {
    const model = new MockLanguageModelV1({
      doGenerate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
        }),
    });
    const { responder } = responderWith(model, { timeoutMs: 20 });

    const error = await responder.generate(INPUT).catch((e: unknown) => e);
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(ResponderConfigurationError);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/agent test -- LlmResponder`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `LlmResponder.ts`**

```ts
import { APICallError, generateText, type LanguageModel } from "ai";
import { getModel, type LlmConfig, type LlmProvider } from "@fmagentes/shared";
import {
  ResponderConfigurationError,
  type AgentConfig,
  type LinkedCustomer,
  type ResponderInput,
  type ResponderPort,
  type ResponderResult,
} from "@fmagentes/messaging";
import { buildPrompt } from "./buildPrompt";
import type { CrmPort } from "./crm/CrmPort";
import { HANDOFF_TOOL_NAME, handoffTool } from "./tools/handoff";
import { createRegisterCustomerTool, type RegistrationOutcome } from "./tools/registerCustomer";

export const DEFAULT_LLM_TIMEOUT_MS = 45_000;
/** Tool call → tool result → final text. */
export const MAX_STEPS = 3;

/** Statuses that mean the agent's configuration is wrong, not that the call failed. */
const CONFIGURATION_STATUSES = new Set([401, 403, 404]);

export interface LlmResponderOptions {
  llm: LlmConfig;
  crm: CrmPort;
  timeoutMs?: number;
  /** Test seam; production builds models with getModel. */
  createModel?: (provider: LlmProvider, model: string) => LanguageModel;
}

export class LlmResponder implements ResponderPort {
  constructor(private readonly options: LlmResponderOptions) {}

  async generate(input: ResponderInput): Promise<ResponderResult> {
    const model = this.modelFor(input.agent);
    const outcome: RegistrationOutcome = {};

    // Registration is only offered while the customer is unregistered, so a
    // registered conversation can never be re-linked by the model.
    const tools =
      input.customer.status === "unregistered"
        ? {
            transferir_para_humano: handoffTool,
            cadastrar_cliente: createRegisterCustomerTool(this.options.crm, input.contactPhone, outcome),
          }
        : { transferir_para_humano: handoffTool };

    let result;
    try {
      result = await generateText({
        model,
        messages: buildPrompt(input),
        tools,
        maxSteps: MAX_STEPS,
        // BullMQ owns retries (3 attempts with backoff); the SDK must not stack its own.
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
      });
    } catch (error) {
      throw classify(error, input.agent);
    }

    const link = withLink(outcome.linked);
    const handoffCall = result.steps
      .flatMap((step) => step.toolCalls)
      .find((call) => call.toolName === HANDOFF_TOOL_NAME);
    if (handoffCall) {
      const summary = String((handoffCall.args as { resumo?: unknown }).resumo ?? "").trim();
      return { kind: "handoff", summary, ...link };
    }

    const text = result.text.trim();
    if (text.length > 0) return { kind: "reply", text, ...link };
    return { kind: "decline", ...link };
  }

  private modelFor(agent: AgentConfig): LanguageModel {
    const provider = agent.provider;
    if (provider !== "anthropic" && provider !== "openai") {
      throw new ResponderConfigurationError(agent.id, `Agent ${agent.id} has unknown provider "${provider}"`);
    }
    const key = provider === "anthropic" ? this.options.llm.anthropicApiKey : this.options.llm.openaiApiKey;
    if (!key) {
      throw new ResponderConfigurationError(agent.id, `No API key configured for ${provider} (agent ${agent.id})`);
    }
    if (this.options.createModel) return this.options.createModel(provider, agent.model);
    return getModel(this.options.llm, provider, agent.model, { cacheControl: provider === "anthropic" });
  }
}

function withLink(linked: LinkedCustomer | undefined): { linkedCustomer?: LinkedCustomer } {
  return linked ? { linkedCustomer: linked } : {};
}

/** Configuration errors become ResponderConfigurationError; everything else is rethrown as is. */
function classify(error: unknown, agent: AgentConfig): unknown {
  if (APICallError.isInstance(error) && error.statusCode !== undefined && CONFIGURATION_STATUSES.has(error.statusCode)) {
    return new ResponderConfigurationError(
      agent.id,
      `LLM rejected agent ${agent.id} (${agent.provider}/${agent.model}) with HTTP ${error.statusCode}: ${error.message}`,
    );
  }
  return error;
}
```

- [ ] **Step 6: Export**

Append to `packages/agent/src/index.ts`:

```ts
export { LlmResponder, DEFAULT_LLM_TIMEOUT_MS, MAX_STEPS, type LlmResponderOptions } from "./LlmResponder";
```

- [ ] **Step 7: Run tests and type-check**

Run: `pnpm --filter @fmagentes/agent test` then `pnpm --filter @fmagentes/agent build`
Expected: PASS; `tsc` clean. If `MockLanguageModelV1`'s `doGenerate` typing rejects the `scripted` responses, adjust only the test helper types (e.g. cast to `GenerateResult`), not the production code.

- [ ] **Step 8: Commit**

```bash
git add packages/shared packages/agent
git commit -m "feat(agent): LlmResponder with tools, timeout and error classification"
```

---

### Task 9: Resume route

**Files:**
- Create: `packages/messaging/src/resumeConversation.ts`
- Modify: `packages/messaging/src/index.ts`
- Test: `packages/messaging/tests/resumeConversation.test.ts`
- Modify: `apps/api/src/routes/conversations.ts`
- Test: `apps/api/tests/conversations.test.ts`

**Interfaces:**
- Consumes: `ConversationNotFoundError` (existing, `sendMessage.ts`).
- Produces: `resumeConversation(deps: Pick<MessagingDeps, "supabase">, conversationId: string): Promise<void>` (throws `ConversationNotFoundError`); route `POST /conversations/:id/resume` → `200 { id, status: "open" }` | `404` | `401`.

- [ ] **Step 1: Write the failing messaging test**

`packages/messaging/tests/resumeConversation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resumeConversation } from "../src/resumeConversation";
import { ConversationNotFoundError } from "../src/sendMessage";
import { createSupabaseMock, type TableCall } from "./support/supabaseMock";

const ID = "6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b";

describe("resumeConversation", () => {
  it("reopens the conversation and clears the handoff", async () => {
    let recorded: TableCall = [];
    const supabase = createSupabaseMock({
      conversations: (calls) => {
        recorded = calls;
        return { data: [{ id: ID }], error: null };
      },
    });

    await resumeConversation({ supabase } as never, ID);

    expect(recorded).toEqual([
      { op: "update", args: [{ status: "open", handoff_summary: null, handoff_at: null }] },
      { op: "eq", args: ["id", ID] },
      { op: "select", args: ["id"] },
    ]);
  });

  it("throws ConversationNotFoundError when nothing was updated", async () => {
    const supabase = createSupabaseMock({ conversations: () => ({ data: [], error: null }) });
    await expect(resumeConversation({ supabase } as never, ID)).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("treats a malformed id as not found without querying", async () => {
    let queried = false;
    const supabase = createSupabaseMock({
      conversations: () => {
        queried = true;
        return { data: [], error: null };
      },
    });

    await expect(resumeConversation({ supabase } as never, "abc")).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(queried).toBe(false);
  });
});
```

Run: `pnpm --filter @fmagentes/messaging test -- resumeConversation` → FAIL.

- [ ] **Step 2: Implement**

`packages/messaging/src/resumeConversation.ts`:

```ts
import type { MessagingDeps } from "./deps";
import { ConversationNotFoundError } from "./sendMessage";
import { assertNoError } from "./internal/supabaseError";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hands a conversation back to the agent. Idempotent: resuming an open
 * conversation succeeds. A malformed id is "not found" rather than a uuid cast
 * error from Postgres.
 */
export async function resumeConversation(
  deps: Pick<MessagingDeps, "supabase">,
  conversationId: string,
): Promise<void> {
  if (!UUID.test(conversationId)) throw new ConversationNotFoundError(conversationId);

  const result = await deps.supabase
    .from("conversations")
    .update({ status: "open", handoff_summary: null, handoff_at: null })
    .eq("id", conversationId)
    .select("id");
  assertNoError(result.error);

  const rows = (result.data as Array<{ id: string }> | null) ?? [];
  if (rows.length === 0) throw new ConversationNotFoundError(conversationId);
}
```

In `packages/messaging/src/index.ts` add:

```ts
export { resumeConversation } from "./resumeConversation";
```

Run: `pnpm --filter @fmagentes/messaging test` → PASS.

- [ ] **Step 3: Write the failing route tests**

In `apps/api/tests/conversations.test.ts`:
- in `vi.hoisted`, return `resumeMock: vi.fn()` alongside `sendMock` (`const { sendMock, resumeMock, ConversationNotFoundError } = vi.hoisted(...)` with `return { sendMock, resumeMock: vi.fn(), ConversationNotFoundError };`)
- in the `vi.mock` factory add `resumeConversation: resumeMock,`
- change `beforeEach` to `beforeEach(() => { sendMock.mockReset(); resumeMock.mockReset(); });`
- append:

```ts
describe("POST /conversations/:id/resume", () => {
  const ID = "6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b";
  const resume = (app: ReturnType<typeof buildApp>, headers: Record<string, string> = AUTH_HEADERS) =>
    app.inject({ method: "POST", url: `/conversations/${ID}/resume`, headers });

  it("401 without a bearer token", async () => {
    const app = buildApp(baseDeps());
    expect((await resume(app, {})).statusCode).toBe(401);
    expect(resumeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("200 and the conversation is open again", async () => {
    resumeMock.mockResolvedValue(undefined);
    const app = buildApp(baseDeps());

    const response = await resume(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: ID, status: "open" });
    expect(resumeMock).toHaveBeenCalledWith(expect.anything(), ID);
    await app.close();
  });

  it("404 when the conversation does not exist", async () => {
    resumeMock.mockImplementationOnce(async () => {
      throw new ConversationNotFoundError(ID);
    });
    const app = buildApp(baseDeps());
    expect((await resume(app)).statusCode).toBe(404);
    await app.close();
  });
});
```

Run: `pnpm --filter @fmagentes/api test -- conversations` → FAIL (route missing → 404 on the 200 test).

- [ ] **Step 4: Implement the route**

In `apps/api/src/routes/conversations.ts`, change the import to:

```ts
import { sendMessage, resumeConversation, ConversationNotFoundError } from "@fmagentes/messaging";
```

and add inside `registerConversationRoutes`, after the messages route:

```ts
  app.post("/conversations/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await resumeConversation(deps, id);
      return reply.code(200).send({ id, status: "open" });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return reply.code(404).send({ error: "conversation not found" });
      }
      throw error;
    }
  });
```

- [ ] **Step 5: Run tests and type-check**

Run: `pnpm --filter @fmagentes/api test` then `pnpm --filter @fmagentes/api build`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add packages/messaging apps/api
git commit -m "feat(api): POST /conversations/:id/resume hands the conversation back to the agent"
```

---

### Task 10: Worker composition — LLM responder, CRM, unrecoverable configuration errors

**Files:**
- Modify: `apps/worker/package.json`, `apps/worker/src/env.ts`, `apps/worker/src/index.ts`, `apps/worker/src/inboundProcessor.ts`, `apps/worker/.env.example`
- Test: `apps/worker/tests/inboundProcessor.test.ts`, `apps/worker/tests/env.test.ts`

**Interfaces:**
- Consumes: `LlmResponder`, `createSupabaseCrm` (agent); `ResponderConfigurationError`, `RespondDeps` (messaging).
- Produces: worker env `CRM_SUPABASE_URL`, `CRM_SUPABASE_SERVICE_KEY`, `CRM_AGENT_USER_ID` (uuid), `ANTHROPIC_API_KEY` (default `""`), `OPENAI_API_KEY` (default `""`), `AGENT_HISTORY_LIMIT` (int 1–200, default 30); exported `envSchema`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/tests/inboundProcessor.test.ts` (and add `UnrecoverableError` to the `bullmq` import, `ResponderConfigurationError` to the messaging import):

```ts
  it("fails a misconfigured agent permanently and names the agent", async () => {
    const respond = vi.fn(async () => {
      throw new ResponderConfigurationError("agent-9", "LLM rejected agent agent-9 with HTTP 401");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const process = createInboundProcessor({} as never, { respond: respond as never });

    await expect(process(job(), "tok")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("agent-9"));
    logged.mockRestore();
  });
```

Create `apps/worker/tests/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { envSchema } from "../src/env";

const BASE = {
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "k",
  EVOLUTION_API_URL: "https://evo.example.com",
  EVOLUTION_API_KEY: "k",
  CRM_SUPABASE_URL: "https://crm.supabase.co",
  CRM_SUPABASE_SERVICE_KEY: "k",
  CRM_AGENT_USER_ID: "6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b",
};

describe("worker envSchema", () => {
  it("defaults the history limit to 30 and LLM keys to empty", () => {
    const env = envSchema.parse(BASE);
    expect(env.AGENT_HISTORY_LIMIT).toBe(30);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.OPENAI_API_KEY).toBe("");
  });

  it("parses AGENT_HISTORY_LIMIT from the string env", () => {
    expect(envSchema.parse({ ...BASE, AGENT_HISTORY_LIMIT: "12" }).AGENT_HISTORY_LIMIT).toBe(12);
  });

  it("rejects a non-uuid CRM_AGENT_USER_ID", () => {
    expect(envSchema.safeParse({ ...BASE, CRM_AGENT_USER_ID: "admin@crm" }).success).toBe(false);
  });

  it("rejects a zero history limit", () => {
    expect(envSchema.safeParse({ ...BASE, AGENT_HISTORY_LIMIT: "0" }).success).toBe(false);
  });
});
```

Run: `pnpm --filter @fmagentes/worker test -- inboundProcessor env` → FAIL.

- [ ] **Step 2: Map configuration errors in the processor**

In `apps/worker/src/inboundProcessor.ts`:
- import: `import { DelayedError, UnrecoverableError, type Job } from "bullmq";` and add `ResponderConfigurationError` to the `@fmagentes/messaging` import
- in the `catch`, after the `ConversationBusyError` branch and before `throw error;`:

```ts
      if (error instanceof ResponderConfigurationError) {
        // A wrong key, provider or model will fail every attempt; stop retrying.
        console.error(`[worker] agent ${error.agentId} is misconfigured: ${error.message}`);
        throw new UnrecoverableError(error.message);
      }
```

- [ ] **Step 3: Extend the env schema**

Replace `apps/worker/src/env.ts` with:

```ts
import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

export const envSchema = z.object({
  REDIS_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  // The CRM is a separate Supabase project, reached with its service key.
  CRM_SUPABASE_URL: z.string().url(),
  CRM_SUPABASE_SERVICE_KEY: z.string().min(1),
  // Auth id of the human CRM user who owns clients the agent creates.
  CRM_AGENT_USER_ID: z.string().uuid(),
  // Optional per provider: an agent on a provider without a key fails as misconfigured.
  ANTHROPIC_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  AGENT_HISTORY_LIMIT: z.coerce.number().int().min(1).max(200).default(30),
});

export const loadEnv = createEnvLoader(envSchema);
export type Env = ReturnType<typeof loadEnv>;
```

Note: importing `env.ts` in the test runs `dotenv`'s `config()` (side effect of `@fmagentes/config`) but does not call `loadEnv`, so the test never exits the process.

- [ ] **Step 4: Wire the composition root**

In `apps/worker/package.json` add `"@fmagentes/agent": "workspace:*",` to `dependencies`, then run `pnpm install`.

In `apps/worker/src/index.ts`:
- replace the messaging import with `import { INBOUND_QUEUE_NAME, type RespondDeps } from "@fmagentes/messaging";`
- add `import { LlmResponder, createSupabaseCrm } from "@fmagentes/agent";`
- replace the `deps` block with:

```ts
const crm = createSupabaseCrm(
  createSupabaseClient({ url: env.CRM_SUPABASE_URL, serviceKey: env.CRM_SUPABASE_SERVICE_KEY }),
  { agentUserId: env.CRM_AGENT_USER_ID },
);

const deps: RespondDeps = {
  supabase: createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY }),
  evolutionApi: createEvolutionApiClient({
    baseUrl: env.EVOLUTION_API_URL,
    apiKey: env.EVOLUTION_API_KEY,
  }),
  responder: new LlmResponder({
    llm: { anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY },
    crm,
  }),
  // The CRM adapter also serves as messaging's read-only customer directory.
  customerDirectory: crm,
  conversationLock: createRedisConversationLock(connection),
  historyLimit: env.AGENT_HISTORY_LIMIT,
};
```

- [ ] **Step 5: Document the env**

Replace `apps/worker/.env.example` with:

```
REDIS_URL=redis://localhost:6379
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
EVOLUTION_API_URL=https://your-evolution-host
EVOLUTION_API_KEY=your-evolution-api-key
# CRM (separate Supabase project, repo "aula"): URL + service-role key
CRM_SUPABASE_URL=https://your-crm-project.supabase.co
CRM_SUPABASE_SERVICE_KEY=your-crm-service-role-key
# Auth user id (uuid) of the human CRM user who handles WhatsApp leads
CRM_AGENT_USER_ID=00000000-0000-0000-0000-000000000000
# At least the key of the provider your agents use
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
# Optional: messages of history the agent sees (default 30)
AGENT_HISTORY_LIMIT=30
```

- [ ] **Step 6: Full verification**

Run: `pnpm build` then `pnpm test` (Redis container up).
Expected: every package builds; every test suite passes (now 7 packages with tests: config, shared, messaging, agent, api, worker, dashboard).

- [ ] **Step 7: Commit**

```bash
git add apps/worker pnpm-lock.yaml
git commit -m "feat(worker): wire LlmResponder and CRM; fail misconfigured agents permanently"
```

---

### Task 11: CRM repo — `cpf` + `phone_digits`, CPF in the client form and table

All paths in this task are in `C:\Users\Dell\Desktop\aula` (repo `mktingfiuzamarine-sudo/agentes_ia`). The CRM has no test runner; its gates are `npm run lint`, `npm run build` and a browser check.

**Files:**
- Create: `supabase/migrations/009_client_cpf_and_phone_digits.sql`
- Create: `lib/cpf.ts`
- Modify: `app/dashboard/clientes/page.tsx`, `app/dashboard/clientes/ClientsTable.tsx`

**Interfaces:**
- Produces (consumed by Task 6's adapter at runtime): `clients.cpf text` (11 digits, unique when not null), `clients.phone_digits text` generated.

- [ ] **Step 1: Branch**

```bash
cd /c/Users/Dell/Desktop/aula && git switch -c feat/cpf-cliente
```

- [ ] **Step 2: Write the migration**

`supabase/migrations/009_client_cpf_and_phone_digits.sql`:

```sql
-- fmagentes (agente WhatsApp): identifica clientes pelo telefone e cadastra
-- com CPF. CPF opcional para clientes criados por humanos no CRM.

ALTER TABLE public.clients
  ADD COLUMN cpf text CONSTRAINT clients_cpf_digits CHECK (cpf ~ '^[0-9]{11}$'),
  -- NUNCA incluir phone_digits em INSERT/UPDATE payloads da aplicação
  ADD COLUMN phone_digits text GENERATED ALWAYS AS (
    regexp_replace(coalesce(phone, ''), '\D', '', 'g')
  ) STORED;

-- Unicidade global (não por usuário): o mesmo CPF é a mesma pessoa.
CREATE UNIQUE INDEX clients_cpf_key ON public.clients (cpf) WHERE cpf IS NOT NULL;
CREATE INDEX idx_clients_phone_digits ON public.clients (phone_digits);
```

- [ ] **Step 3: Apply it to the CRM project**

Find the CRM project ref in `aula/.env.local` (`NEXT_PUBLIC_SUPABASE_URL` = `https://<ref>.supabase.co`). Apply with `mcp__plugin_supabase_supabase__apply_migration` `{ project_id: "<ref>", name: "client_cpf_and_phone_digits", query: "<file contents>" }` if the MCP account can see that project; otherwise ask the user to run the file in that project's SQL Editor.

Verify with `execute_sql` (or ask the user to run):

```sql
select phone, phone_digits from public.clients limit 5;
```

Expected: `phone_digits` = `phone` without non-digits; empty string where `phone` is null.

- [ ] **Step 4: CPF helpers**

`lib/cpf.ts`:

```ts
export function normalizeCpf(input: string): string {
  return input.replace(/\D/g, '')
}

/** 11 dígitos, não todos iguais, dígitos verificadores corretos. */
export function isValidCpf(input: string): boolean {
  const digits = normalizeCpf(input)
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false

  const checkDigit = (length: number) => {
    let sum = 0
    for (let i = 0; i < length; i++) sum += Number(digits[i]) * (length + 1 - i)
    const remainder = (sum * 10) % 11
    return remainder === 10 ? 0 : remainder
  }

  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10])
}

/** Máscara progressiva 000.000.000-00 enquanto o usuário digita. */
export function formatCpf(input: string): string {
  const d = normalizeCpf(input).slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
}
```

- [ ] **Step 5: Select the column**

In `app/dashboard/clientes/page.tsx` change the select to:

```ts
    .select('id, name, company, email, phone, cpf, notes, created_at', { count: 'exact' })
```

- [ ] **Step 6: Form, validation, table**

In `app/dashboard/clientes/ClientsTable.tsx`:

1. Import: `import { formatCpf, isValidCpf, normalizeCpf } from '@/lib/cpf'`
2. `type Client`: add `cpf: string | null` after `phone`.
3. `clientSchema`: add after `phone`:

```ts
  cpf: z
    .string()
    .trim()
    .transform(normalizeCpf)
    .pipe(z.union([z.literal(''), z.string().refine(isValidCpf, 'CPF inválido')])),
```

4. Every `form.reset({...})` / `defaultValues`: add `cpf: ''` for new, and in `openEdit` add `cpf: formatCpf(client.cpf ?? ''),`.
5. In `onSubmit`'s `payload`, add `cpf: data.cpf || null,`.
6. Replace the two error toasts so a CPF collision is explained (23505 is the only unique constraint a user can hit on `clients`):

```ts
      if (error) {
        toast.error(error.code === '23505' ? 'CPF já cadastrado em outro cliente' : 'Erro ao atualizar cliente')
        return
      }
```

and

```ts
      if (error) {
        toast.error(error.code === '23505' ? 'CPF já cadastrado em outro cliente' : 'Erro ao criar cliente')
        return
      }
```

7. In the search filter's `target` array add `c.cpf` after `c.phone`.
8. Table header: add `<th className="px-4 py-2 text-left font-medium">CPF</th>` after "Telefone"; body: add after the phone cell:

```tsx
                <td className="px-4 py-2 font-mono text-muted-foreground">
                  {client.cpf ? formatCpf(client.cpf) : '—'}
                </td>
```

and change the empty-state `colSpan={5}` to `colSpan={6}`.

9. Form field, after the Telefone field:

```tsx
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="client-cpf">CPF</Label>
              {(() => {
                const cpfField = form.register('cpf')
                return (
                  <Input
                    id="client-cpf"
                    inputMode="numeric"
                    maxLength={14}
                    placeholder="000.000.000-00"
                    aria-describedby="client-cpf-error"
                    aria-invalid={!!form.formState.errors.cpf}
                    {...cpfField}
                    onChange={(e) => {
                      e.target.value = formatCpf(e.target.value)
                      void cpfField.onChange(e)
                    }}
                  />
                )
              })()}
              <div id="client-cpf-error" aria-live="polite" aria-atomic="true">
                {form.formState.errors.cpf && (
                  <p className="text-xs text-destructive">{form.formState.errors.cpf.message}</p>
                )}
              </div>
            </div>
```

- [ ] **Step 7: Lint and build**

Run (in `aula`): `npm run lint` then `npm run build`
Expected: no errors.

- [ ] **Step 8: Browser check**

Run `npm run dev`, log in, open Clientes (use the claude-in-chrome or playwright tools, or ask the user). Check:
1. Typing `52998224725` shows `529.982.247-25`.
2. Saving with `111.111.111-11` shows "CPF inválido" and nothing is saved.
3. Saving a new client with `529.982.247-25` works; the CPF column shows it formatted.
4. Creating a second client with the same CPF shows "CPF já cadastrado em outro cliente".
5. Editing a client and clearing the CPF saves (CPF optional).
Delete the test clients afterwards.

- [ ] **Step 9: Commit (explicit paths — never `-A` here)**

```bash
cd /c/Users/Dell/Desktop/aula
git add supabase/migrations/009_client_cpf_and_phone_digits.sql lib/cpf.ts app/dashboard/clientes/page.tsx app/dashboard/clientes/ClientsTable.tsx
git commit -m "feat(clientes): CPF com validacao e phone_digits para o agente WhatsApp"
```

Do not merge or push the CRM branch without asking the user.

---

### Task 12: End-to-end verification and ROADMAP

Manual, against real services: real LLM (`claude-haiku-4-5`), real fmagentes + CRM databases, Evolution replaced by a local stub (VPS LID bug). Requires Tasks 1–11.

**Files:**
- Modify: `scripts/seed-test-agent.sql`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Prerequisites from the user**

Ask the user for (or confirm):
1. `CRM_AGENT_USER_ID` — which CRM user handles WhatsApp leads (their Auth uuid: Supabase dashboard of the CRM project → Authentication → Users).
2. Permission to copy the CRM URL and service key from `aula/.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) into `apps/worker/.env` as `CRM_SUPABASE_URL` / `CRM_SUPABASE_SERVICE_KEY`.
3. Permission to copy `ANTHROPIC_API_KEY` from `apps/api/.env` into `apps/worker/.env`.
4. One CRM client, owned by any user, with a phone the test will use for scenario 2 (e.g. create "Cliente Teste Telefone" with phone `(11) 90000-0002` in the CRM UI).

Then fill `apps/worker/.env` (gitignored).

- [ ] **Step 2: Rewrite the seed script**

`scripts/seed-test-agent.sql`:

```sql
-- Sub-project 4 verification: an active LLM agent on the instance under test.
-- Replace :instance_id with the instances.id you are exercising.
-- The oldest active agent wins resolution, and a conversation pinned to a
-- deactivated agent gets no answer, so retire older agents and unpin.
update agents set is_active = false where instance_id = :'instance_id';
update conversations set agent_id = null where instance_id = :'instance_id';

insert into agents (name, provider, model, system_prompt, instance_id, is_active)
values (
  'Atendente de teste',
  'anthropic',
  'claude-haiku-4-5',
  $$Você atende a Loja Exemplo, que vende acessórios náuticos.
Horário: segunda a sexta, 9h às 18h. Entregas para todo o Brasil em até 7 dias úteis.
Para orçamento de produtos sob encomenda, colete o produto desejado e a quantidade e transfira para um atendente.$$,
  :'instance_id',
  true
);
```

Run it via `execute_sql` with the `smoke-test-final` instance id substituted (look it up: `select id from instances where evolution_instance_id = 'smoke-test-final';`).

- [ ] **Step 3: Start the stack with the Evolution stub**

1. `docker compose up -d redis`
2. Stub (scratchpad file, not committed), e.g. `<scratchpad>/evolution-stub.cjs`:

```js
require("http")
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      console.log(new Date().toISOString(), req.method, req.url, body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ key: { id: `STUB-${Date.now()}` } }));
    });
  })
  .listen(4555, "127.0.0.1");
```

Run it in the background with `node <path>`.
3. Temporarily set `EVOLUTION_API_URL=http://127.0.0.1:4555` in `apps/worker/.env` (note the original value to restore).
4. `pnpm dev` in the background; wait for `[worker] listening` and the API on port 3001.

- [ ] **Step 4: Run the four scenarios**

Send messages by POSTing a `messages.upsert` webhook (shape of `apps/api/tests/fixtures/messages-upsert.json`) to `http://localhost:3001/webhooks/evolution` with header `apikey: <WEBHOOK_SECRET from apps/api/.env>`, `instance: "smoke-test-final"`, a unique `key.id` per message, `remoteJid: "<phone>@s.whatsapp.net"`, and **no** `messageTimestamp` drift concerns (any value). Read each bot answer in the stub's log and in `messages` (`direction = 'out'`). Wait for the answer before sending the next message.

1. **New customer** — phone `5511900000001` (not in the CRM): "Oi, quero saber o horário de vocês" → agent asks name/CPF/e-mail → send "Bruno Teste, 529.982.247-25, bruno.teste@example.com" → agent confirms and answers the hours from the prompt. Check in the CRM: client `Bruno Teste`, `cpf = 52998224725`, `user_id = CRM_AGENT_USER_ID`, `notes = 'Cadastrado pelo agente WhatsApp'`; in fmagentes `conversations.crm_link_via = 'created'`.
2. **Known phone** — phone `5511900000002` (the CRM client from Step 1.4): "Oi" → greeted by name, no registration asked; `crm_link_via = 'phone'`.
3. **Handoff** — on conversation 2: "Quero falar com um atendente" → (agent may ask once for basics; insist) → stub receives the agent's `handoff_message`; `conversations.status = 'awaiting_human'`, `handoff_summary` non-empty. Send "Alguém aí?" → worker log `skipped` (`awaiting-human`), no new stub call.
4. **Resume** — `POST /conversations/:id/messages` with `{ "text": "Oi, aqui é o Rafael, já vejo seu pedido" }` (human reply; needs `Authorization: Bearer <access token of an allowlisted user>`), then `POST /conversations/:id/resume` → 200; send "Obrigado! E o prazo de entrega?" → agent answers (7 dias úteis) and its reply reflects the human's message being in history.

Also check `apps/worker` logs show no `failed` jobs, and record per scenario: worker log lines, the `messages` rows (direction, content, created_at, received_at) and the CRM row.

- [ ] **Step 5: Clean up**

Restore `EVOLUTION_API_URL` in `apps/worker/.env`; stop the stub and `pnpm dev`; delete the test clients from the CRM (`Bruno Teste`) only if the user agrees; leave the seeded agent (document it).

- [ ] **Step 6: Record in ROADMAP**

In `docs/ROADMAP.md`:
- table row 4 → `✅ **Complete** (merged <pending>, <date>)`, row 5 → `▶ Next`;
- add "## Sub-project 4 — Núcleo do Agente/LLM (done)" with: what was delivered (one paragraph per area: agent package, handoff, CRM, debts paid), the e2e evidence from Step 4, the six "Refinements to the spec" from this plan's header, and "Debt carried forward": the spec's Known gaps (fromMe not persisted; sendMessage sends before persisting; failed-after-3 LLM jobs leave the customer unanswered with no alert; RLS `using (true)` + CRM service key; VPS Evolution LID bug) plus anything new found during e2e;
- mark the two sub-project 3 debt bullets (two clocks, lock renewal) as paid by sub-project 4.

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-test-agent.sql docs/ROADMAP.md
git commit -m "docs: encerra sub-projeto 4 com verificacao end-to-end"
```

Then use superpowers:finishing-a-development-branch for `feat/nucleo-agente` (and ask the user about merging/pushing `feat/cpf-cliente` in `aula`).
