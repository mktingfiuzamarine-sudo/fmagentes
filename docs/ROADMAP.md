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
| 2 | **Integração Evolution API** | Real webhook processing, sending messages, instance management. | ▶ Next — no spec/plan yet |
| 3 | **Fila/Worker (BullMQ)** | Real business jobs: process incoming message, generate response, send response. | Planned |
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

## Sub-project 2 — Integração Evolution API (next)

Fundação already ships the seams this sub-project makes real:

- `POST /webhooks/evolution` — a log-only receiver in `apps/api`.
- `evolutionApiClient` in `packages/shared` — `checkConnection`,
  `getInstanceStatus`, `sendMessage` (thin fetch wrapper, 5s timeout).

The Evolution API instance is already deployed and reachable (v2.3.1, behind a
reverse proxy). It uses the **same Supabase project** as this app: Evolution's
own tables live in a dedicated `evolution` schema, this app's tables in
`public`. Operational details and credentials are held outside the repo.

### Carry-over items to address in this sub-project

All were deliberately deferred in Fundação (plan scoped out production concerns):

- The webhook route performs no authenticity verification and logs the full
  request body (which will contain contact PII) at info level.
- The global error handler converts every error on the webhook route into
  HTTP 200 — fine while the route is log-only, not once it does real work.
- `POST /test/enqueue` is unauthenticated and registered unconditionally; it
  should be env-gated or removed before any real deployment.
- `evolutionApiClient.ts` interpolates `instanceName` / `to` unescaped into URL
  paths — safe only while no caller passes external input.
- RLS policies are `using (true) with check (true)` — every authenticated user
  can read/write every row. No tenant isolation yet.

## Local development notes

- Node **>= 22**, pnpm, Turborepo.
- Redis runs locally via `docker compose up -d`.
- `pnpm run dev` starts api (:3001), worker, and dashboard (:3000) via Turbo.
  It spawns `turbo` + `tsx watch` child processes — stopping it needs the whole
  process tree killed, not just whatever holds the ports, or a stray worker
  keeps draining the BullMQ queue and the e2e queue test fails.
- Each app needs its own `.env` (copy from the committed `.env.example`).
