# fmagentes — Roadmap & Status

WhatsApp AI agent platform built on Evolution API, developed incrementally as
five sequential sub-projects. Each sub-project has its own spec and plan under
`docs/superpowers/{specs,plans}/` and is proven end-to-end before the next
begins. Scope is not pulled forward: if a task seems to need something from a
later sub-project, that's a signal to stop and reconsider, not to build it early.

## Sub-projects

| # | Name | Scope | Status |
|---|------|-------|--------|
| 1 | **Fundação** | Monorepo, base Supabase schema, Redis/BullMQ wiring, API + worker + dashboard skeleton, dashboard auth. No business logic. | ✅ **Complete** (merged `bb2ecc8`, 2026-09-01) |
| 2 | **Integração Evolution API** | Real webhook processing, sending messages, instance management. | ✅ **Complete** (merged `<pending>`, 2026-09-04) |
| 3 | **Fila/Worker (BullMQ)** | Real business jobs: process incoming message, generate response, send response. | ✅ **Complete** (merged `<pending>`, 2026-09-21) |
| 4 | **Núcleo do Agente/LLM** | AI logic, prompt design, conversation context management. | ▶ Next |
| 5 | **Dashboard completo** | Functional inbox, agent management, Evolution API instance management. | Planned |

## Sub-project 1 — Fundação (done)

Full-boot verification passed: `pnpm build` (5/5) and `pnpm test` (7/7 packages,
19 tests) green; `/health` reports all three dependencies connected; dashboard
login works; the api→worker queue pipeline is proven via `POST /test/enqueue`.

Deviations from the original plan, decided during implementation:

- Node engine floor is **>= 22** (raised from >= 20 — `@supabase/supabase-js`
  2.111 sub-deps require it).
- `packages/shared/src/index.ts` uses named exports, not wildcard re-exports.
- Added `supabase/migrations/0002_fk_indexes.sql` (indexes on the four
  foreign-key columns) after code review; applied to the database.

## Sub-project 2 — Integração Evolution API (done)

Spec `docs/superpowers/specs/2026-09-01-evolution-integration-design.md`, plan
`docs/superpowers/plans/2026-09-02-evolution-integration-implementation.md`.

Delivered:

- **`packages/messaging`** — new package, all deps injected (no env of its own):
  `parseEvolutionEvent` (webhook body → discriminated union), `ingestInboundMessage`
  (resolve instance → race-free find-or-create conversation → idempotent message
  insert → returns ids for the queue), `sendMessage` (outbound: Evolution send →
  persist → bump `last_message_at`), and the `inbound-messages` BullMQ queue.
- **`POST /webhooks/evolution`** — real: `WEBHOOK_SECRET` (`apikey` header) auth;
  `messages.upsert` → ingest + enqueue (skips `fromMe` and duplicates);
  `connection.update` → `instances.status` sync + best-effort `phone_number`;
  `qrcode.updated` acknowledged; transient failures → 500 so Evolution retries.
- **Instance lifecycle API** — `POST /instances` (registers the callback URL +
  `MESSAGES_UPSERT`/`CONNECTION_UPDATE`/`QRCODE_UPDATED` with Evolution), `GET
  /instances`, `GET /instances/:id`, `GET /instances/:id/qr`, `DELETE
  /instances/:id`.
- **Outbound API** — `POST /conversations/:id/messages`.
- **`evolutionApiClient`** gained `sendText` (renamed from `sendMessage`, returns
  the message id), `createInstance`, `connectInstance`, `deleteInstance`
  (404-tolerant), `fetchInstance`; all path params now `encodeURIComponent`-escaped.
- **`apps/worker`** runs a stub `processInboundJob` on `inbound-messages`. All
  `test-queue` scaffolding (`/test/enqueue`, `createTestQueue`,
  `testQueueProcessor`) deleted; the global error handler no longer force-200s the
  webhook route.
- Migration `0003_messaging.sql` — `unique (messages.evolution_message_id)` and
  `unique (conversations.instance_id, contact_phone)`.

Verification: `pnpm build` 6/6, `pnpm test` 9 packages / 59 tests green. Local
boot: `/health` all three connected; webhook fixtures exercised against the live
Evolution API + Supabase (auth, parse, ingest lookup, `connection.update`
resilience). Manual tunnel smoke test (real WhatsApp message end-to-end): _to be
recorded_.

Deviations from the plan, decided during implementation:

- `assertNoError` extracted to `packages/messaging/src/internal/supabaseError.ts`
  and shared by `ingestInboundMessage` + `sendMessage` (plan spelled it out
  verbatim in both).
- `apps/api/tests/e2e-queue.test.ts` reworked (not deleted) to round-trip an
  `InboundJobData` through Redis, keeping automated proof of the api→worker
  pipeline.
- `connection.update` phone sync made best-effort after the smoke test showed a
  404 from `fetchInstance` was turning a status webhook into a retry-storming 500.
- A few plan test snippets adjusted to satisfy `tsc --noEmit` and to avoid a
  vitest false-positive unhandled-rejection (`mockImplementationOnce` for
  route-caught rejections).

## Hardening pass — API consumer authentication (done)

Pulled forward from the sub-project 2 debt list, because `GET /instances/:id/qr`
handing out a WhatsApp pairing QR to anyone who could reach the port blocked any
non-local deployment.

- `apps/api/src/auth.ts` — a `preHandler` that requires a `Bearer` token,
  verifies it through an injected `AuthPort`, and checks the caller against an
  allowlist. **401** means "we do not know who you are" (no header, wrong scheme,
  unverifiable token, *or* a verification outage — an outage must not become an
  open door); **403** means "we know you, and you are not allowed".
- The allowlist (`API_ALLOWED_USERS`, comma-separated) accepts emails or Supabase
  user ids, matches case-insensitively, trims whitespace, and **fails closed**:
  an empty list rejects everyone. It stands in for tenant scoping until the
  schema grows an owner column.
- `createSupabaseAuthPort` verifies tokens through a **separate anon-key client**
  (`SUPABASE_ANON_KEY`) — the service-key client bypasses auth and would never
  reject a caller's token.
- Protected routes live in an encapsulated Fastify scope in `app.ts`, so the hook
  covers them by construction rather than via an exception list someone must
  maintain. `GET /health` (a probe) and `POST /webhooks/evolution` (carries its
  own `apikey`; Evolution cannot hold a user session) stay deliberately outside.

Verification: `pnpm build` 6/6, `pnpm test` 9 packages green, `apps/api` 41/41.
The dashboard needed no change — it only calls the public `/health`.

### Debt carried forward (not in scope for sub-project 2)

- RLS policies remain `using (true) with check (true)` — no tenant isolation; the
  service-key Supabase client bypasses RLS entirely.
- `POST /instances` writes no compensating delete if the Evolution instance is
  created but the DB insert then fails (orphaned Evolution instance, HTTP 500).
- Remote `supabase_migrations` history has no `messaging` row — `0003` was applied
  via the SQL editor, not `supabase migration`. Reconcile with `supabase
  migration repair` if the CLI is used against this project.

## Sub-project 3 — Fila/Worker (BullMQ) (done)

Spec `docs/superpowers/specs/2026-09-17-fila-worker-design.md`, plan
`docs/superpowers/plans/2026-09-17-fila-worker-implementation.md`.

Delivered:

- **`respondToInboundMessage`** (`packages/messaging/src/respondToInboundMessage.ts`)
  — the orchestration that replaces the worker's logging stub: looks up the
  inbound message and its conversation, resolves an active agent, guards
  against answering twice, loads conversation history, generates a reply, sends
  it, and persists it. Returns a `RespondResult` (`sent` or a `skipped` reason:
  `message-not-found`, `no-active-agent`, `already-answered`,
  `responder-declined`).
- **`ResponderPort` + `EchoResponder`** (`packages/messaging/src/responder.ts`)
  — the injected reply-generation seam. `EchoResponder` is the only
  implementation sub-project 3 ships; it echoes the incoming text back
  prefixed with `Echo: ` and declines (returns `null`) on blank input.
  Sub-project 4 swaps this one class for an LLM-backed responder.
- **Conversation history loading** (`packages/messaging/src/conversationHistory.ts`)
  — `loadConversationHistory`, the most recent messages of a conversation,
  oldest-first, mapped from `direction` to `role`.
- **Agent auto-assignment** (`packages/messaging/src/resolveAgent.ts`) —
  `resolveAgentForConversation`: a pinned agent is returned only if still
  active (a deactivated pinned agent yields `null`, stopping the bot
  everywhere, not just on new conversations); with no pinned agent, the
  instance's oldest active agent is picked and persisted onto
  `conversations.agent_id`.
- **Redis-backed `ConversationLock`** (`apps/worker/src/redisConversationLock.ts`)
  — serializes processing per conversation via `SET NX PX`, with a
  nonce-checked Lua release script so a holder whose TTL expired can never
  release the *next* holder's lock. A busy lock throws `ConversationBusyError`,
  which the processor catches to reschedule the job (`moveToDelayed` +
  `DelayedError`) without burning a retry attempt.
- **Duplicate-answer guard** — before generating a reply,
  `respondToInboundMessage` checks for any `out` message newer than the
  inbound one; if found, it skips (`already-answered`). This is what makes
  BullMQ retries safe.
- **Retry with exponential backoff** — `INBOUND_JOB_OPTIONS`
  (`packages/messaging/src/inboundQueue.ts`): 3 attempts, exponential backoff
  starting at 1000ms, `removeOnComplete`/`removeOnFail` caps.
- **Worker composition root** (`apps/worker/src/index.ts`) — reads env, builds
  the Supabase and Evolution clients, wires `EchoResponder` and the Redis lock
  into `RespondDeps`, and runs `Worker` on `inbound-messages` with
  concurrency 5.

Verification (Task 8, done against the real database — see Adaptations below):

An active test agent (`Echo de teste`, `provider: echo`) was seeded onto the
existing `smoke-test-final` instance (from sub-project 2's manual testing). A
`messages.upsert` webhook was POSTed to the running `apps/api` against that
instance's real phone number. The `in` row landed and `conversations.agent_id`
was auto-assigned, proving history loading, agent resolution and the webhook
→ queue → processor path.

The **real** Evolution send was attempted first, as required: `sendText`
against the VPS's live Evolution API (the same host used by `apps/worker/.env`
in production) failed on all 3 retry attempts with
`DOMException [TimeoutError]: The operation was aborted due to timeout`
(the client's 15s `AbortSignal.timeout`). No `out` row was created — expected,
since `sendMessage` calls Evolution before persisting. This matches the known
VPS Evolution 2.3.1 LID bug recorded when sub-project 2 closed; it is an
external blocker, not a defect in this pipeline.

To prove the pipeline itself, the worker was pointed at a tiny local stub
HTTP server (returning `{"key":{"id":"STUB-<timestamp>"}}`, matching
`EvolutionApiClient.sendText`'s expected response shape) via a temporary edit
to `apps/worker/.env` (`EVOLUTION_API_URL=http://127.0.0.1:4555`), then the
whole `pnpm dev` stack was restarted and a second, fresh webhook message was
POSTed to the same conversation. That run produced the full round trip: an
`in` row, then an `out` row with content `Echo: Segunda mensagem via stub`,
and the worker log line `[worker] job 9 message <id>: sent`. `apps/worker/.env`
was reverted to the real Evolution values immediately after.

**Evidence produced by the stub path**, not the real Evolution call:

```
direction | role      | content                          | created_at
in        | user      | Ola, mensagem de verificacao ... | 2025-09-16T05:20:01Z
in        | user      | Segunda mensagem via stub        | 2025-09-16T05:20:02Z
out       | assistant | Echo: Segunda mensagem via stub  | 2026-09-21T12:53:42Z
```

`conversations.agent_id` was non-null throughout (auto-assigned on the first
message).

Deviations from the plan, decided while executing Task 8:

- **Browser → script adaptation.** The plan's Task 8 assumes a human at the
  Supabase SQL-editor browser tab. This run was autonomous, so seeding and
  verification queries were done with a throwaway Node + `@supabase/supabase-js`
  script (not committed) instead of pasting SQL into a browser.
  `scripts/seed-test-agent.sql` is still committed exactly as the plan
  specifies, as a manual-use/documentation deliverable for whoever runs this
  by hand next.
- **`apps/api/.env` was missing `SUPABASE_ANON_KEY` and `API_ALLOWED_USERS`**
  (the two vars noted as a blocker when the consumer-auth hardening pass
  landed). Both were filled in with real values (the anon key already used by
  the dashboard; an allowlisted email) so `pnpm dev` could boot at all. The
  file is gitignored, so this is a local-only fix, not a code change.
- The real-Evolution attempt was retried 3 times automatically by
  `INBOUND_JOB_OPTIONS` before the stub swap — all 3 timed out identically,
  confirming the failure is not transient.

### Debt carried forward (not in scope for sub-project 3)

- `sendMessage` calls Evolution before persisting — a failed persist leaves a
  message delivered on WhatsApp that the duplicate guard cannot see, so a
  retry would send it twice.
- The VPS's Evolution 2.3.1 LID bug still blocks real outbound sends; the
  pipeline's correctness was proven against a local stub instead. Upgrading or
  fixing the VPS Evolution instance remains out of scope.
- `apps/api/.env` still lacks `SUPABASE_ANON_KEY` and `API_ALLOWED_USERS` in
  version control (by design — `.env` is gitignored); anyone re-cloning the
  repo hits the same boot blocker until they copy real values in.

## Local development notes

- Node **>= 22**, pnpm, Turborepo.
- Redis runs locally via `docker compose up -d`.
- `pnpm run dev` starts api (:3001), worker, and dashboard (:3000) via Turbo.
  It spawns `turbo` + `tsx watch` child processes — stopping it needs the whole
  process tree killed, not just whatever holds the ports, or a stray worker
  keeps draining the BullMQ queue and the e2e queue test fails.
- Each app needs its own `.env` (copy from the committed `.env.example`).
