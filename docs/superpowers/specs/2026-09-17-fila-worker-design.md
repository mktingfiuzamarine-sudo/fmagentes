# Sub-project 3 — Fila/Worker (BullMQ) — Design

**Date:** 2026-09-17
**Depends on:** Sub-project 2 (Evolution API Integration) — merged at `19ab9ad`;
consumer auth merged at `2f1a6cb`.
**Roadmap context:** `docs/ROADMAP.md`. Sub-project 2 left a stub
`processInboundJob`; this sub-project makes it do real work. Sub-project 4
(Núcleo do Agente/LLM) plugs a real model into the seam defined here.

## Goal

Turn the logging stub on the `inbound-messages` queue into the real business
pipeline: an inbound WhatsApp message is picked up, matched to an active agent,
answered, and the answer is sent back and persisted — with serialization per
conversation, retry with backoff, and a duplicate guard that makes retries safe.

The response text itself is produced by an injected `ResponderPort` whose only
implementation here is a trivial echo. No LLM call, no prompt design, no
conversation-memory strategy — those are sub-project 4, and the port exists so
that sub-project 4 changes one line of wiring in `apps/worker` and nothing else.

## Scope

**In scope**
- `respondToInboundMessage` — the whole job as a dependency-injected domain
  operation in `packages/messaging`.
- `ResponderPort` + `EchoResponder`.
- `ConversationLock` port + Redis implementation in `apps/worker`.
- `loadConversationHistory`.
- Agent resolution with auto-assignment onto `conversations.agent_id`.
- Duplicate guard (skip when a newer outbound message already exists).
- Queue hardening: `attempts`, exponential backoff, retention limits, worker
  concurrency.
- `apps/worker` env grows Supabase + Evolution credentials.

**Out of scope**
- Any LLM / model call, prompt engineering, token budgeting (sub-project 4).
- Dashboard UI for agents or the inbox (sub-project 5).
- A dedicated dead-letter queue — BullMQ's `failed` set is sufficient and has no
  consumer yet.
- Upgrading the VPS Evolution API to 2.3.7. The LID bug that blocks real
  WhatsApp delivery is an external blocker; this sub-project is proven through
  the database, not through a phone.
- Rewriting `sendMessage`'s send-then-persist ordering (see Known gaps).

## Decisions

Each of these was chosen deliberately during brainstorming; the rejected option
is recorded so a later reader does not relitigate it.

1. **The responder is a port with a trivial implementation.** Rejected: calling
   the model here (mixes two concerns, inflates this sub-project); rejected:
   shipping only queue plumbing with no response at all (nothing observable
   end-to-end until sub-project 4).
2. **One queue, one job does everything.** `inbound-messages` loads context,
   generates, and sends. Rejected: chaining an `outbound-messages` queue — two
   workers and an intermediate state to persist, for a generation step that is
   currently free. Revisit when generation becomes expensive.
3. **Serialize per conversation with a Redis lock.** Rejected: global
   concurrency 1 (one slow conversation blocks all); rejected: a debounce window
   (latency plus a constant to tune, and the duplicate guard already collapses
   bursts).
4. **Resolve the instance's active agent and auto-assign it.** Rejected:
   requiring `agent_id` to be pre-set (no conversation would ever be answered
   before the dashboard exists); rejected: always responding (never exercises the
   agent resolution sub-project 4 depends on).
5. **Retry with backoff plus a duplicate guard.** Rejected: retry without a
   guard (a failure after a successful send duplicates the message on the user's
   phone).
6. **Orchestration lives in `packages/messaging`, not `apps/worker`.** It follows
   the pattern sub-project 2 proved: no env inside the package, everything
   injected, so the business rule is testable without Redis or BullMQ. Rejected:
   orchestrating in `apps/worker` (business logic in an app that needs infra to
   test); rejected: a new `packages/pipeline` (one package for one function).

## Architecture

New files:

| Path | Responsibility |
|---|---|
| `packages/messaging/src/respondToInboundMessage.ts` | the orchestration |
| `packages/messaging/src/responder.ts` | `ResponderPort`, `EchoResponder` |
| `packages/messaging/src/conversationLock.ts` | `ConversationLock` interface, `noopLock` |
| `packages/messaging/src/conversationHistory.ts` | `loadConversationHistory` |
| `apps/worker/src/redisConversationLock.ts` | Redis lock implementation |

Changed files: `packages/messaging/src/deps.ts` (two optional deps),
`packages/messaging/src/inboundQueue.ts` (`defaultJobOptions`),
`packages/messaging/src/index.ts` (exports), `apps/worker/src/env.ts` (four new
vars), `apps/worker/src/index.ts` (composition, `concurrency`),
`apps/worker/src/inboundProcessor.ts` (stub → real), `apps/worker/.env.example`.

`InboundJobData` is unchanged — `{ messageId, conversationId, instanceId }`
already carries everything the job needs.

## Job flow

1. **Lock.** `conversationLock.acquire(conversationId)`. If it returns `null`
   (busy), the processor calls `job.moveToDelayed(Date.now() + 2000, token)` and
   returns without consuming an attempt.
2. **Load.** The inbound message row plus its conversation, in one query. Missing
   row (conversation deleted) → `skipped: message-not-found`.
3. **Agent gate.** Use `conversation.agent_id` when set. When null, select the
   instance's active agent (`is_active = true`, oldest `created_at` when several)
   and write it to `conversations.agent_id`, pinning the conversation. No active
   agent → `skipped: no-active-agent`, job completes successfully.
4. **Duplicate guard.** If an `out` message exists with `created_at` greater than
   the inbound message's, → `skipped: already-answered`. This is what makes a
   retry after a successful send safe.
5. **History.** The last 20 messages of the conversation, chronological,
   `direction: in → role: user`, `out → assistant`.
6. **Generate.** `responder.generate({ agent, history, incoming })` → `string`
   or `null`. `null` is a deliberate decision not to answer →
   `skipped: responder-declined`.
7. **Send.** Reuse `sendMessage`. → `{ status: "sent", messageId }`.

The lock guarantees mutual exclusion per conversation, **not strict FIFO** —
BullMQ may deliver the second message's job before the first's. Two messages
arriving in a burst are handled by steps 4 and 5 together: whichever job takes
the lock first reads a history containing both messages and answers both; the
second job sees a newer outbound message and skips. One answer per burst is the
desired behaviour, but it is not an ordering guarantee and should not be
described as one.

## Contracts

```ts
export interface AgentConfig {
  id: string; name: string; provider: string;
  model: string; systemPrompt: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ResponderInput {
  agent: AgentConfig;
  history: HistoryMessage[];   // chronological, includes the incoming message
  incoming: HistoryMessage;
}

export interface ResponderPort {
  generate(input: ResponderInput): Promise<string | null>;
}

export type RespondResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: "no-active-agent" | "already-answered"
        | "responder-declined" | "message-not-found" };

export interface ConversationLock {
  acquire(conversationId: string): Promise<{ release(): Promise<void> } | null>;
}
```

`AgentConfig` carries `provider`, `model` and `systemPrompt` even though
`EchoResponder` ignores all three: they are exactly what sub-project 4 consumes,
and exposing them now costs nothing.

`MessagingDeps` gains `responder?: ResponderPort` and
`conversationLock?: ConversationLock` as **optional** fields, so every existing
sub-project 2 call site and test keeps compiling unchanged.
`respondToInboundMessage` takes a narrower `RespondDeps` that requires both.

The Redis lock uses `SET lock:conv:<id> <nonce> NX PX 30000` and releases via a
Lua script that checks the nonce before deleting — releasing another holder's
lock is the classic way to get this wrong. The 30s TTL is sized for the
Evolution call, which has hung before.

## Queue configuration

`createInboundQueue` sets `defaultJobOptions`: `attempts: 3`, exponential
backoff with a 1s base delay, `removeOnComplete: { count: 1000 }`,
`removeOnFail: { count: 5000 }`. Keeping it on the producer side puts it in one
place and leaves `apps/api` untouched. The `Worker` gets `concurrency: 5`, a
fixed value for now; it becomes an env var if it ever hurts.

## Error handling

| Situation | Treatment |
|---|---|
| Inbound message row gone | terminal → `skipped: message-not-found` |
| No active agent / responder returned `null` | terminal → `skipped` |
| `ConversationNotFoundError` from `sendMessage` | terminal → `skipped` (a retry cannot fix it) |
| Supabase error (`assertNoError`) | propagate → retry with backoff |
| Evolution timeout / 5xx | propagate → retry with backoff |
| Lock busy | neither → `moveToDelayed`, no attempt consumed |

After three attempts the job rests in BullMQ's `failed` set with its stack
intact.

## Testing

TDD: the test for each behaviour is written before its implementation.

- `packages/messaging/tests/respondToInboundMessage.test.ts` — the bulk, using
  the existing `supabaseMock` plus a fake responder and fake lock. Cases: happy
  path; no active agent; null `agent_id` → auto-assignment persisted; existing
  `agent_id` not overwritten; duplicate guard fires; responder returns `null`;
  Supabase error propagates; `ConversationNotFoundError` becomes a skip.
- `packages/messaging/tests/conversationHistory.test.ts` — chronological order,
  the 20-message limit, `direction` → `role` mapping.
- `packages/messaging/tests/responder.test.ts` — `EchoResponder`.
- `apps/worker/tests/redisConversationLock.test.ts` — needs a real Redis (the
  same `docker-compose` container the queue tests use): mutual exclusion,
  release only by the owner, TTL expiry.
- `apps/worker/tests/inboundProcessor.test.ts` — rewritten: a busy lock calls
  `moveToDelayed` and does not throw; delegation is correct.

## Verification

1. `pnpm build` 6/6 and `pnpm test` green, with Redis running (Docker Desktop is
   currently stopped and must be started first).
2. Local boot: `pnpm dev`, `/health` reporting all three dependencies connected.
3. End-to-end through the database, without depending on WhatsApp: POST the real
   `messages.upsert` fixture at the webhook endpoint → conversation and `in`
   message in Supabase → job consumed → **`out` message persisted** with the echo
   text. The Evolution call will fail while the VPS LID bug stands; the criterion
   is the `out` row and the job landing in `completed`/`failed` with the expected
   error — not delivery to a phone.
4. A real WhatsApp smoke test is explicitly **not** a completion criterion. It
   depends on upgrading the VPS Evolution API to 2.3.7, which is out of scope.

To exercise step 3, at least one `agents` row must exist and be active for the
test instance; the plan includes seeding it.

## Known gaps carried forward

- `sendMessage` calls Evolution **before** persisting. If the persist fails, the
  message has already reached WhatsApp and the duplicate guard cannot see it, so
  the retry sends it again. Not rewritten here — it works and is proven — but it
  is recorded as debt in `docs/ROADMAP.md`.
- Pre-existing debt unchanged by this sub-project: RLS still
  `using(true) with check(true)`; `POST /instances` orphans the Evolution-side
  instance when the DB insert fails; migration `0003` has no
  `supabase_migrations` history row.
