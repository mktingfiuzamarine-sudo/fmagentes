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
| 3 | **Fila/Worker (BullMQ)** | Real business jobs: process incoming message, generate response, send response. | ▶ Next |
| 4 | **Núcleo do Agente/LLM** | AI logic, prompt design, conversation context management. | Planned |
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

### Debt carried forward (not in scope for sub-project 2)

- **`apps/api` has no consumer authentication.** The instance-management and
  outbound-message routes are open to anyone who can reach the port — including
  `GET /instances/:id/qr`, which hands out a WhatsApp pairing QR. An API auth
  layer (Supabase JWT verification or an internal service token) must land with
  the dashboard build (sub-project 5, the first real consumer) or a dedicated
  hardening pass **before any non-local deployment**.
- RLS policies remain `using (true) with check (true)` — no tenant isolation; the
  service-key Supabase client bypasses RLS entirely.
- `POST /instances` writes no compensating delete if the Evolution instance is
  created but the DB insert then fails (orphaned Evolution instance, HTTP 500).
- Remote `supabase_migrations` history has no `messaging` row — `0003` was applied
  via the SQL editor, not `supabase migration`. Reconcile with `supabase
  migration repair` if the CLI is used against this project.

## Local development notes

- Node **>= 22**, pnpm, Turborepo.
- Redis runs locally via `docker compose up -d`.
- `pnpm run dev` starts api (:3001), worker, and dashboard (:3000) via Turbo.
  It spawns `turbo` + `tsx watch` child processes — stopping it needs the whole
  process tree killed, not just whatever holds the ports, or a stray worker
  keeps draining the BullMQ queue and the e2e queue test fails.
- Each app needs its own `.env` (copy from the committed `.env.example`).
