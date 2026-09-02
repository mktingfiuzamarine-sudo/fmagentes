# Sub-project 2 — Evolution API Integration — Design

**Date:** 2026-09-01
**Depends on:** Sub-project 1 (Fundação) — merged at `bb2ecc8`.
**Roadmap context:** `docs/ROADMAP.md`. This sub-project makes the Fundação
webhook/queue seams real; sub-project 3 fills in what the worker *does*.

## Goal

Turn the log-only `POST /webhooks/evolution` receiver and the `evolutionApiClient`
stub into a working integration: inbound WhatsApp messages are authenticated,
parsed, persisted, and enqueued onto a real `inbound-messages` queue; instances
can be created / connected / deleted through the API with their Evolution-side
lifecycle kept in sync; and outbound text messages can be sent through the API
and persisted. No AI, no agent logic, no dashboard UI.

## Scope

**In scope**
- Real `POST /webhooks/evolution`: shared-secret auth, event dispatch for
  `messages.upsert`, `connection.update`, `qrcode.updated`.
- Inbound pipeline: resolve instance → find-or-create conversation → persist
  inbound `message` (idempotent) → enqueue `inbound-messages` job.
- Instance lifecycle API: `POST /instances`, `GET /instances`,
  `GET /instances/:id`, `GET /instances/:id/qr`, `DELETE /instances/:id`.
- Outbound send API: `POST /conversations/:id/messages`.
- New `packages/messaging` with the reusable domain operations.
- New `inbound-messages` queue; stub worker processor (logs + returns).
- Delete all `test-queue` scaffolding.
- Debt fixes carried from Fundação (see "Carry-over fixes").

**Out of scope** (unchanged from Fundação)
- AI / LLM response generation, prompt design, conversation context (sub-project 4).
- Agent endpoints or agent-to-conversation assignment — new conversations get
  `agent_id = null`.
- Delivery / read receipts (`messages.update`), and any `messages.status` column.
- Dashboard UI for inbox or instances (sub-project 5). The existing status page
  is untouched.
- Multi-tenancy, RLS tightening, production deployment.
- `contacts` table — a conversation keyed by `(instance_id, contact_phone)` is
  sufficient for now.

## Architecture

### New package: `packages/messaging`

Domain operations over conversations and messages. Depends on `packages/shared`
(types, `supabaseClient`, `evolutionApiClient`). Consumed by `apps/api` now and
`apps/worker` in sub-project 3. All external dependencies (Supabase client,
Evolution client) are injected — the package reads no env of its own.

Exports:

- `INBOUND_QUEUE_NAME` — `"inbound-messages"`.
- `InboundJobData` — `{ messageId: string; conversationId: string; instanceId: string }`.
- `createInboundQueue(connection: Redis): Queue<InboundJobData>`.
- `ingestInboundMessage(deps, event: EvolutionInboundEvent): Promise<Message | null>`
  — resolve instance by `evolution_instance_id`; if unknown, return `null`.
  Find-or-create conversation by `(instance_id, contact_phone)`. Insert the
  inbound `message` row with `on conflict (evolution_message_id) do nothing`.
  Return the persisted row, or `null` if it was a duplicate / unknown instance.
- `sendMessage(deps, { conversationId, text }): Promise<Message>` — load the
  conversation and its instance; call `evolutionApiClient.sendText`; on success
  insert the outbound `message` row (`evolution_message_id` from the response)
  and bump `conversation.last_message_at`. Propagates the Evolution client's
  error on failure (nothing persisted).

`deps` is `{ supabase: SupabaseClient; evolutionApi: EvolutionApiClient }`.

### `packages/shared` — `evolutionApiClient` additions

New methods, alongside the existing `checkConnection` / `getInstanceStatus` /
`sendMessage` (renamed to `sendText` for clarity — single call site to update):

- `createInstance(name: string, webhook: { url: string; events: string[] }): Promise<void>`
  — Evolution `POST /instance/create` with the integration type and webhook
  block in the payload.
- `connectInstance(name: string): Promise<{ qrcode: string | null; pairingCode: string | null }>`
  — Evolution `GET /instance/connect/:name`.
- `deleteInstance(name: string): Promise<void>` — Evolution `DELETE /instance/delete/:name`;
  treats a 404 as success.

**Debt fix:** every path parameter (`name`, instance name, phone) is passed
through `encodeURIComponent` before interpolation into the request path.

### `apps/api` — routes

| Method + path | Behaviour |
|---|---|
| `POST /instances` | body `{ name }`. Evolution `createInstance` with `${PUBLIC_WEBHOOK_URL}/webhooks/evolution` + the 3 event names → insert `instances` row (`status='created'`, `evolution_instance_id = name`) → 201 with the row. Evolution failure → 502, no row. |
| `GET /instances` | DB read, all rows. |
| `GET /instances/:id` | DB read; 404 if absent. |
| `GET /instances/:id/qr` | Load row (404 if absent) → Evolution `connectInstance` → set `status='connecting'` → 200 `{ qrcode, pairingCode }`. Evolution failure → 502. |
| `DELETE /instances/:id` | Load row (404 if absent) → Evolution `deleteInstance` → delete row (cascades) → 204. |
| `POST /conversations/:id/messages` | body `{ text }`. `messaging.sendMessage` → 201 with the row. Conversation absent → 404. Evolution failure → 502. |
| `POST /webhooks/evolution` | See "Inbound flow". |
| ~~`POST /test/enqueue`~~ | Deleted. |

The `apps/api` dependency wiring (`src/index.ts`) swaps `testQueue` for the
`inbound-messages` queue and passes `{ supabase, evolutionApi, inboundQueue }`
into the messaging calls.

### `apps/worker`

`testQueueProcessor` is deleted. The worker subscribes to `INBOUND_QUEUE_NAME`
with a stub processor that logs `[worker] inbound job <id> for message <messageId>`
and returns `{ ok: true }`. Real processing is sub-project 3.

## Data model

Migration `supabase/migrations/0003_messaging.sql`:

```sql
-- idempotent webhook ingest
alter table messages add constraint messages_evolution_message_id_key
  unique (evolution_message_id);

-- race-free find-or-create conversation
alter table conversations add constraint conversations_instance_contact_key
  unique (instance_id, contact_phone);

comment on column instances.status is
  'lifecycle: created | connecting | connected | disconnected';
```

- `evolution_message_id` stays nullable; Postgres treats multiple NULLs as
  distinct, so an outbound send that somehow gets no id from Evolution still
  inserts. Inbound events always carry `key.id`.
- No new tables, no `messages.status`, no enum types.

**Field conventions for `messages`:**
- inbound: `direction = 'in'`, `role = 'user'`
- outbound: `direction = 'out'`, `role = 'assistant'`

**`instances.status` vocabulary** (app-level constant in `packages/shared`, not a
DB enum): `created` → `connecting` → `connected` → `disconnected`. The
`connection.update` webhook maps Evolution's connection states onto these and
writes `phone_number` when a session reaches `connected`.

## Flows

### Inbound message — `messages.upsert`

1. Verify `apikey` header equals `WEBHOOK_SECRET`. Mismatch / missing → **401**.
2. Parse the body. Unknown event type, or a shape we can't parse → log, **200**
   (not retriable).
3. `message.key.fromMe === true` → ignore (our own outbound, echoed back), **200**.
4. `ingestInboundMessage(deps, event)`:
   - instance lookup by `evolution_instance_id` fails → log warning, return
     `null` → route responds **200**.
   - find-or-create conversation by `(instance_id, contact_phone)`.
   - `insert message ... on conflict (evolution_message_id) do nothing`.
5. A row was inserted → `inboundQueue.add(INBOUND_QUEUE_NAME, { messageId,
   conversationId, instanceId })`. Duplicate (no row) → skip enqueue.
6. Respond **200**. Any DB / Redis exception thrown from steps 4–5 →
   **500** — Evolution retries, and steps 4–5 are idempotent.

### Outbound message — `POST /conversations/:id/messages`

1. Load conversation + its instance. Missing → **404**.
2. `evolutionApiClient.sendText(instanceName, contactPhone, text)`.
3. Success → insert outbound `message` (`evolution_message_id` from response),
   bump `conversation.last_message_at` → **201** with the row.
4. Evolution failure → **502**, nothing persisted.

### Instance lifecycle

- **Create:** `POST /instances { name }` → Evolution `createInstance(name,
  { url: PUBLIC_WEBHOOK_URL + '/webhooks/evolution', events: ['MESSAGES_UPSERT',
  'CONNECTION_UPDATE', 'QRCODE_UPDATED'] })` → insert row `status='created'` →
  201. Evolution failure → 502, no row written.
  *(Note: Evolution's instance-create webhook config uses the UPPER_SNAKE event
  names; the webhook payload's `event` field arrives dotted-lowercase —
  `messages.upsert`, `connection.update`, `qrcode.updated` — which is what the
  dispatch switch matches on.)*
- **Connect:** `GET /instances/:id/qr` → Evolution `connectInstance` → row
  `status='connecting'` → 200 `{ qrcode, pairingCode }`. QR is not persisted.
- **Sync:** `connection.update` webhook → map state → update `status` and, on
  connect, `phone_number`.
- **Read:** `GET /instances`, `GET /instances/:id` → DB only.
- **Delete:** `DELETE /instances/:id` → Evolution `deleteInstance` (404 tolerated)
  → delete row; `on delete cascade` removes its conversations and messages → 204.

## Configuration

| var | app | purpose |
|---|---|---|
| `WEBHOOK_SECRET` | api | Shared secret. Sent to Evolution in the instance-create webhook config; checked on every inbound webhook request. |
| `PUBLIC_WEBHOOK_URL` | api | Base URL Evolution calls back. Dev: a tunnel (ngrok / cloudflared). Prod: the real domain. `POST /instances` registers `${PUBLIC_WEBHOOK_URL}/webhooks/evolution`. |

Both are `zod`-validated (`WEBHOOK_SECRET`: non-empty; `PUBLIC_WEBHOOK_URL`: URL),
fail-fast, and added to `apps/api/.env.example`. `packages/messaging` reads no
env — dependencies are injected.

## Error handling

- Route handlers return typed HTTP errors (400 / 401 / 404 / 502).
- The global Fastify error handler in `apps/api/src/app.ts` stops special-casing
  `/webhooks/evolution` (Fundação debt) — unexpected errors render as 500 like
  any other route.
- `evolutionApiClient` throws on any non-2xx response; `packages/messaging` lets
  those propagate; route handlers catch and map to **502**.
- The webhook `messages.upsert` handler is the one place that deliberately
  swallows-and-200s non-retriable problems (bad payload, unknown instance), and
  returns **500** only for transient infrastructure failure.

## Testing (Vitest — the Definition of Done)

**`packages/messaging`:**
- `ingestInboundMessage`: new message; duplicate (`on conflict` no-op → returns
  null, no enqueue); unknown instance → null; conversation found vs. created.
- `sendMessage`: success path (row + `last_message_at`); Evolution failure
  (throws, nothing persisted).
- Supabase and Evolution clients mocked.

**`apps/api`:**
- Webhook route, driven by **captured real JSON fixtures** (`messages.upsert`,
  `connection.update`, `qrcode.updated`) committed under
  `apps/api/tests/fixtures/`: valid secret; bad / missing secret → 401;
  `fromMe` → ignored 200; unknown event → 200; transient failure → 500.
- Instance routes: create (success / Evolution failure), get, list, qr, delete
  — Evolution client mocked.
- Conversation send route: 201, 404, 502.

No live Evolution API in the suite. A manual tunnel smoke test (real WhatsApp
message → tunnel → local API → row + queued job) is documented in the
implementation plan as a one-time manual check, not automated.

## Carry-over fixes (from Fundação, folded into this sub-project)

- `apps/api/src/app.ts` — remove the `/webhooks/evolution` special-case in the
  global error handler.
- `packages/shared/src/evolutionApiClient.ts` — `encodeURIComponent` all path
  parameters.
- `POST /test/enqueue`, `packages/shared/src/testQueue.ts`,
  `apps/worker/src/testQueueProcessor.ts` and their tests — deleted with the
  `test-queue` replacement.

Still deferred (documented, not addressed here): RLS tenant isolation; the
service-key Supabase client bypassing RLS; production deployment.

## Definition of Done

1. `pnpm build` and `pnpm test` green across all packages.
2. New `packages/messaging` with passing unit tests.
3. Webhook fixture tests pass for all three event types plus the auth and
   failure cases.
4. `test-queue` code fully removed; `inbound-messages` queue + stub worker in
   place.
5. Instance and conversation routes pass their tests.
6. Migration `0003_messaging.sql` applies cleanly.
7. One manual tunnel smoke test performed and its result recorded.
