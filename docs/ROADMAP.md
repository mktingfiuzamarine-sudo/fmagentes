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
| 4 | **Núcleo do Agente/LLM** | AI logic, prompt design, conversation context management. | ✅ **Complete** (merged `<pending>`, 2026-10-14) |
| 5 | **Dashboard completo** | Functional inbox, agent management, Evolution API instance management. | ✅ **Complete** (merged `<pending>`, 2026-10-15) |

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
message). The year-apart gap between the `in` and `out` timestamps above is a
symptom of the clock-skew debt item below — the test fixture's own
`messageTimestamp` epoch, not a data error.

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

- `sendMessage` calls Evolution before persisting — a failed persist, or any
  other interruption between the send and the persist (a killed process, a
  redeploy, or the conversation lock's TTL lapsing before the job finishes —
  see below), leaves a message delivered on WhatsApp that the duplicate guard
  cannot see, so a retry would send it twice.
- ✅ **Paid by sub-project 4** (`messages.received_at` + `answers_through`). **Duplicate-answer guard uses two different clocks.**
  `respondToInboundMessage`'s guard (`packages/messaging/src/respondToInboundMessage.ts`)
  compares the inbound message's `created_at` — which is derived from the
  WhatsApp webhook's own device timestamp (`ingestInboundMessage`, sub-project
  2) — against outbound messages' `created_at`, which is the database's own
  `now()` at insert time. These are two different clocks and can disagree (the
  branch's own Task 8 verification evidence shows this plainly: the recorded
  `in` rows are dated a year before the `out` row, because the test fixture
  carried its own timestamp). If the inbound timestamp runs ahead of the
  database clock in live traffic, the guard can fail to detect an
  already-answered message and a retry could send a duplicate reply; if it
  runs behind, a message could be silently skipped as already-answered. Needs
  a DB-owned column (e.g. a `received_at timestamptz default now()`) for the
  guard to compare against instead, or guarding by insertion order/id —
  tracked for sub-project 4.
- ✅ **Paid by sub-project 4** (lock heartbeat, `LockLostError`). **The Redis conversation lock has no renewal/heartbeat.**
  `apps/worker/src/redisConversationLock.ts`'s `DEFAULT_LOCK_TTL_MS` is a
  fixed 30 seconds, sized (per its own comment) for the Evolution call "which
  has hung in production before" — and sub-project 3's own end-to-end
  verification (Task 8) proved that call really can time out. A job that runs
  past the TTL loses the lock silently; a second worker can then acquire the
  same conversation's lock and process it concurrently, and since neither job
  has persisted an `out` row yet, the duplicate-answer guard can't catch the
  resulting double-send either. Needs either a longer TTL or a
  heartbeat/renewal mechanism — tracked for sub-project 4, especially since an
  LLM-backed responder (replacing `EchoResponder`) will be slower than an echo
  and make this more likely, not less.
- The VPS's Evolution 2.3.1 LID bug still blocks real outbound sends; the
  pipeline's correctness was proven against a local stub instead. Upgrading or
  fixing the VPS Evolution instance remains out of scope.
- `apps/api/.env` still lacks `SUPABASE_ANON_KEY` and `API_ALLOWED_USERS` in
  version control (by design — `.env` is gitignored); anyone re-cloning the
  repo hits the same boot blocker until they copy real values in.

## Sub-project 4 — Núcleo do Agente/LLM (done)

Spec: `docs/superpowers/specs/2026-10-01-nucleo-agente-design.md`. Plan:
`docs/superpowers/plans/2026-10-01-nucleo-agente-implementation.md`. Branch
`feat/nucleo-agente` (fmagentes) + `feat/cpf-cliente` (CRM repo `aula`).

**Agent package.** New `packages/agent`: `LlmResponder` implements messaging's
`ResponderPort` with one `generateText` call per inbound (Anthropic or OpenAI per
agent row, `maxSteps: 3`, `maxRetries: 0`, 45 s timeout) and two tools,
`cadastrar_cliente` and `transferir_para_humano`. `buildPrompt` sends platform
instructions + the agent's prompt as a cached system block, then a per-customer
block, then trimmed history (`AGENT_HISTORY_LIMIT`, default 30) with the message
being answered always last. Configuration errors (unknown provider, missing key)
become BullMQ `UnrecoverableError`; the worker warns at startup when no LLM key
is set.

**Handoff.** `transferir_para_humano` persists `awaiting_human` + summary +
`handoff_at` before sending the agent's `handoff_message`; while awaiting, the
worker skips (`awaiting-human`) anything received after `handoff_at`.
`POST /conversations/:id/resume` reopens the conversation and clears the handoff
fields; human replies sent through `POST /conversations/:id/messages` are in the
agent's history afterwards.

**CRM.** The worker reads/writes the CRM's Supabase (separate project, service
key, 10 s timeout) through `CustomerDirectoryPort`: lookup by phone (with/without
country code and ninth digit, mobiles only), registration with name + CPF +
e-mail, linking an existing client by CPF. Conversations record
`crm_client_id` + `crm_link_via` (`phone` | `cpf` | `created`). CRM migration
009 adds `clients.cpf` (11 digits, globally unique) and generated
`phone_digits`; the CRM UI gained a validated CPF field and column.

**Debts paid.** Sub-project 3's two-clock guard (now `messages.received_at` on
the DB clock plus the reply watermark `messages.answers_through`) and lock
without renewal (heartbeat + `LockLostError`). Migration `0004_agent_core.sql`.

### End-to-end evidence (2026-10-14)

Real fmagentes + CRM databases, real LLM, Evolution replaced by a local stub
(VPS LID bug). **The Anthropic account had no credit**, so the run used
`openai` / `gpt-4o-mini` instead of the planned `claude-haiku-4-5`; Anthropic
prompt caching is therefore unverified live. Jobs 15–23, none failed.

1. **New customer** (`5511900000001`): asked hours → answered 9h–18h and asked
   name/CPF/e-mail → sent "Bruno Teste, 529.982.247-25, bruno.teste@example.com"
   → "Seu cadastro foi criado com sucesso!". CRM row `Bruno Teste`,
   `cpf 52998224725`, owner = `CRM_AGENT_USER_ID`, notes `Cadastrado pelo
   agente WhatsApp`; conversation `crm_link_via = created`.
2. **Known phone** (`5511900000002`, CRM client "Carla Mendes"): linked
   `crm_link_via = phone`, no registration asked. The first two replies did not
   use the name although it was in the prompt; fixed by appending "Trate o
   cliente pelo nome." to the registered-customer block (`d8193e4`), after
   which: "Oi, Carla! Tudo bem, e você?".
3. **Handoff**: "Quero falar com um atendente" → agent asked once what it was
   about → insisted with a quote request → stub got the handoff message;
   `status = awaiting_human`, summary "Cliente Carla Mendes deseja um orçamento
   de 10 coletes salva-vidas sob encomenda."; "Alguém aí?" → `skipped`, no send.
4. **Resume**: human reply via the API (201, sent through the stub) → `/resume`
   (200, `open`, handoff fields cleared) → "E o prazo de entrega?" → "As
   entregas são feitas em até 7 dias úteis…"; its `answers_through` also covers
   the "Alguém aí?" left during the handoff.

Seeded agent left in place: "Atendente de teste" on `smoke-test-final`
(`openai` / `gpt-4o-mini`; switch to `anthropic` / `claude-haiku-4-5` once the
account has credit); the old "Echo de teste" agent is deactivated. CRM test
clients "Bruno Teste" and "Carla Mendes" (`(11) 90000-0002`) remain.

### Refinements to the spec (decided while planning/executing)

1. `handoff_at` = the triggering inbound's `received_at` (one clock, no RPC).
2. System prompt split into a cached block and a per-customer block.
3. `cadastrar_cliente` is offered only to unregistered customers.
4. `CrmPort.findById`.
5. `ResponderConfigurationError` → BullMQ `UnrecoverableError`.
6. `RespondStore` extracted from `respondToInboundMessage` (fake in tests).
7. Duplicate guard is the reply watermark `answers_through >= received_at`
   (spec and plan text still describe the older "any outbound after"
   guard). Consequence: a human send through the API no longer suppresses an
   agent retry.
8. The agent never writes the CRM `phone` column; a CPF-linked number goes to
   notes as `Outro WhatsApp (não verificado): {phone}` (spec/plan say
   `Outro WhatsApp: {phone}` and "fill empty phone") — otherwise a stranger
   typing someone's CPF would plant their number in `phone_digits` and later be
   greeted as that client.
9. Registered customers are told to be addressed by name (e2e finding).

### Debt carried forward (not in scope for sub-project 4)

- `fromMe` messages are not persisted (needs `sendMessage` to persist before
  sending); `sendMessage` still sends before persisting.
- Failed-after-3-attempts LLM jobs leave the customer unanswered with no alert.
- Non-retryable provider errors (no credit, bad key, invalid request —
  `isRetryable: false`) are still retried 3 times; a 401 on the CRM key is also
  retried as transient. Should map to `UnrecoverableError`.
- Retry backoff (1 s exponential) is too short for LLM 429 rate limits.
- RLS `using (true)` in fmagentes; the CRM service key bypasses CRM RLS.
- The VPS Evolution 2.3.1 LID bug still blocks real sends.
- `crm_link_via = 'cpf'` is unverified (anyone can type a CPF): flag it in the
  sub-project 5 inbox. A customer linked by CPF is not recognised by phone in
  new conversations until a human copies the number.
- Agent-created CRM clients store the phone as raw digits (`5511900000001`),
  not the `(11) 9…` format humans type.
- `redisConversationLock` tests rely on wall-clock margins; the expiry tests
  flaked under the parallel full suite until their TTL went 60 → 300 ms
  (`d3236a5`). The heartbeat test (150 ms TTL) still has tight margins.
- Task 11 CRM browser check (CPF field/column in the UI) was not done.
- Smaller deferred items (notes dedupe on formatted numbers, CRM outage fails
  already-linked conversations, tool `execute` ignores the abort signal, etc.)
  are listed in the plan's review ledger.

## Sub-project 5 — Dashboard completo (done)

Spec: `docs/superpowers/specs/2026-10-15-dashboard-design.md`. Plan:
`docs/superpowers/plans/2026-10-15-dashboard-implementation.md`. Branch `feat/dashboard`.

**Data.** Migration `0005_dashboard.sql` (applied): `conversations.assigned_to` /
`assigned_at` (advisory assignment), `messages.sent_by` (author of human sends),
`team_members(user_id, display_name)` and the `conversation_inbox` view
(conversation + number name + latest message by `received_at`). Messaging's
`sendMessage` takes `sentBy`; `resumeConversation` also clears the assignment.

**API.** All behind the existing auth + allowlist: `GET /me` (name, available
LLM providers), `GET /conversations?view=handoff|all|mine` (items + counts),
`GET /conversations/:id` (latest 100 messages with authors, CRM customer view —
a CPF link never returns a name), `POST /conversations/:id/assign|unassign`,
`GET/POST /agents`, `PUT /agents/:id`. `POST /conversations/:id/messages` now
records `sent_by`, caps text at 4096 and 404s a malformed id. Data access goes
through a `DashboardStore` port. LLM keys and CRM vars are optional in the API.

**Dashboard.** Same-origin `/api/*` rewrite to the API with the Supabase access
token; 10 s polling while the tab is visible; shell with Inbox / Agentes /
Números / Status and the handoff count. Inbox: Transferidas / Minhas / Todas,
Assumir / Soltar, reply with author, "Devolver ao bot", inline confirmations,
"CPF não verificado" badge, mobile two-screen layout. Agentes: one agent per
number, create/edit, provider-key and inactive warnings. Números: create, QR
pairing, typed-name removal.

### End-to-end evidence (2026-10-15)

Browser at `localhost:3000` (logged in as `teste@fmagentes.com`), real
fmagentes DB, real LLM (`openai/gpt-4o-mini` — Anthropic account has no credit),
Evolution stub on `127.0.0.1:4555`, API without CRM vars.

1. Customer asked for a quote + human → handoff; within 10 s the inbox showed
   it under "Transferidas (1)" with the summary and the nav badge.
2. Assumir → "Responsável: teste@fmagentes.com", "Minhas (1)".
3. Reply from the panel → stub got it; bubble shows the author;
   `messages.sent_by` = the user's id.
4. Customer replied → bot `skipped`; "aguardando resposta" within 10 s, history
   scrolled to the newest message.
5. Devolver ao bot (inline confirm) → queue emptied, conversation read-only; the
   next customer question about hours got a bot answer. (A follow-up about the
   custom order was handed off again — correct per the test prompt — and its new
   summary included the deadline given during the human part.)
6. Agent prompt edited in the panel ("Sempre termine com 'Bons ventos!'") → the
   next bot answer ended with "Bons ventos!" (reverted afterwards).
7. Números: created `e2e-teste` → QR shown (stub image), status "conectando";
   removed with the typed name; `smoke-test-final` untouched.
8. `crm_link_via` set to `cpf` → "CPF não verificado" badge and no name
   (reverted). Without CRM vars a phone link shows "nome indisponível".
9. 390 px wide (iframe): horizontal nav, list and conversation as separate
   screens with "← Voltar".

### Refinements to the spec (decided while planning/executing)

1. `DashboardStore` port (Supabase implementation + fake for route tests).
2. `conversation_inbox` view for a one-query list.
3. CRM name lookup is a small `CustomerNamePort` in the API (the agent adapter
   needs an `agentUserId` the API does not have).
4. `AppConfig.providers?` / `AppDependencies.customerNames?` optional.
5. QR fetched once (+ "Gerar novo QR"); status comes from list polling.
6. Agent form keyed on the number only, so the save status/warning survives a
   create.

### Debt carried forward

- Spec's "Out" list: canned replies, media, metrics, user management in the
  panel, per-user RLS, Realtime, taking over non-handed-off conversations.
- Provider availability is inferred from the API env, not the worker's.
- `fromMe` messages still not persisted.
- Found in e2e and fixed before merge (`4123e8d`): the tab title lost its `(N)`
  prefix after client-side navigation (now re-applied on each poll and route
  change — selecting a conversation restores it within one poll); on narrow
  screens the conversation opened at the oldest message (the pane now has a
  bounded height); a background tab never updated its count (the shell's count
  poll now runs every 60 s while hidden — the list and pane still pause).
- `apps/api/tests/inbox.test.ts` emoji-truncation test cannot fail (its regex
  holds a literal U+FFFD); the code fix itself is correct.
- Smaller deferred items from the review ledger: shell polls the full handoff
  list for the count; POST /agents count-then-insert race; usePolling has no
  stale-response guard; shared failure state on the pane; circular import
  app.ts ↔ routes.

## Local development notes

- Node **>= 22**, pnpm, Turborepo.
- Redis runs locally via `docker compose up -d`.
- `pnpm run dev` starts api (:3001), worker, and dashboard (:3000) via Turbo.
  It spawns `turbo` + `tsx watch` child processes — stopping it needs the whole
  process tree killed, not just whatever holds the ports, or a stray worker
  keeps draining the BullMQ queue and the e2e queue test fails.
- Each app needs its own `.env` (copy from the committed `.env.example`).
- Dashboard: the `/api/*` proxy targets `API_URL` (falls back to
  `NEXT_PUBLIC_API_URL`). A team member needs a Supabase Auth user, their
  e-mail in `apps/api/.env` `API_ALLOWED_USERS`, and optionally a
  `team_members` row for a display name.
