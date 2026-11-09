# "Asked for a human" alert on the CRM board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a WhatsApp customer is handed to a human, the deal card of that subject turns red on the CRM board, blue with the attendant's name once someone clicks "Assumir" in the dashboard, and back to normal on "Devolver ao robô".

**Architecture:** Three new columns on CRM `deals` (`attention`, `attention_since`, `attention_by`) hold the alert. The worker marks the deal `waiting` at handoff (deal chosen by the model via `transferir_para_humano.negocio_id`, else the client's most recent open deal) and stores it on `conversations.handoff_deal_id`. The API flips it to `in_service`/`waiting`/cleared on assign/unassign/resume. The CRM board paints the cards and refreshes itself every 30 s.

**Tech Stack:** TypeScript, Vercel AI SDK 3.4, Supabase (two projects), Fastify (API), BullMQ (worker), Next.js 15 (CRM), vitest, SQL tests run as dry-run transactions.

**Spec:** `docs/superpowers/specs/2026-11-09-alerta-atendente-crm-design.md`

## Global Constraints

- CRM DB `nzeghgeytskpaqplgngj` is PRODUCTION: migration 015 is tested only inside `begin; … rollback;` and applied only after the owner's explicit "ok".
- fmagentes DB is `odqqiteoskmfpwrlqyrb`; new migration `supabase/migrations/0008_handoff_deal.sql`.
- Writing the alert never blocks a handoff, assign, unassign or resume: catch, log, continue.
- Alert writes never change `deals.updated_at`.
- `authenticated` (CRM staff) must not be able to write `attention*` (it only has `GRANT UPDATE (title, value, client_id, updated_at)` since 006 — keep it that way).
- Cards in the last stage of their pipeline are never painted.
- UI copy (pt-BR, exact): `Esperando atendente · há {n} min` (`há menos de 1 min` when n = 0), `Em atendimento: {nome}`.
- Commits: CRM in pt-BR, fmagentes in English; both end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. CRM repo: never stage the stray `.png` files or `.claude/settings.local.json`.

## Review Focus

1. Model passes a `negocio_id` from another client, a closed deal, or garbage → must fall back to the most recent open deal in scope, never mark a foreign deal (Task 3 test `resolveAlertDeal ignores out-of-scope and closed ids`).
2. Unverified (CPF-typed) link → only deals this conversation created are candidates (Task 3 test `resolveAlertDeal on unverified link only sees this conversation's deals`).
3. CRM down during handoff → handoff, status and notice still happen; `handoff_deal_id` stays null (Task 2 test `handoff still goes through when the alert fails`).
4. Conversation without `handoff_deal_id` (older handoffs, no CRM client) → assign/unassign/resume never call the CRM (Task 4 test `assign without handoff deal does not touch the CRM`).
5. A drag in progress or an open dialog when the 30 s refresh fires → no lost optimistic move, no closed dialog (Task 6 manual check + skip refresh while `dragging`/dialog open).

---

### Task 1: CRM migration 015 (attention columns) + SQL test — CRM repo

**Files:**
- Create: `C:\Users\Dell\Desktop\aula\supabase\migrations\015_deal_attention.sql`
- Create: `C:\Users\Dell\Desktop\aula\supabase\tests\015_deal_attention.test.sql`
- Modify: `C:\Users\Dell\Desktop\aula\supabase\tests\README.md` (add the 015 line)

**Interfaces:**
- Produces: `public.deals.attention text null CHECK (attention IN ('waiting','in_service'))`, `attention_since timestamptz null`, `attention_by text null`; trigger function `public.set_deal_updated_at()` replacing `set_updated_at()` on `deals_updated_at`.

- [ ] **Step 1: Write the test** (`015_deal_attention.test.sql`, style of `014_…test.sql`: one `do $$ … $$`, uses the first existing client, ends with `select 'TESTE 015 OK'`). Assertions:
  - insert a deal; `update deals set attention='waiting', attention_since=now()` → `updated_at` unchanged (compare to the value read before).
  - `update deals set title='x'` → `updated_at` changes.
  - `attention='other'` raises `check_violation`.
  - `in_service` with `attention_by='Ana'` round-trips.
  - `has_column_privilege('authenticated','public.deals','attention','UPDATE')` is false (same for `attention_since`, `attention_by`).
- [ ] **Step 2: Dry-run without the migration** — `begin;` + test + `rollback;` via MCP `execute_sql` on `nzeghgeytskpaqplgngj`. Expected: error (column "attention" does not exist).
- [ ] **Step 3: Write 015**: add the three columns + CHECK; `create or replace function public.set_deal_updated_at()` that keeps `NEW.updated_at := OLD.updated_at` when `to_jsonb(NEW) - '{attention,attention_since,attention_by,updated_at}'::text[]` equals the same for OLD, else `now()`; `SET search_path = pg_catalog, public`; drop/recreate trigger `deals_updated_at` with it. No GRANT changes.
- [ ] **Step 4: Dry-run with the migration** — `begin;` + 015 + test + `rollback;`. Expected: `TESTE 015 OK`. Then confirm nothing stayed: `select count(*) from information_schema.columns where table_name='deals' and column_name='attention'` → 0.
- [ ] **Step 5: Commit** (CRM, branch `feat/alerta-atendente`): `feat(funis): alerta de atendimento nos negocios (migracao 015)`. Do NOT apply to production here (Task 7).

### Task 2: Messaging — alert port, `handoff_deal_id`, handoff flows — fmagentes

**Files:**
- Create: `supabase/migrations/0008_handoff_deal.sql` (`alter table public.conversations add column handoff_deal_id uuid null;` — no FK, other database)
- Create: `packages/messaging/src/dealAlert.ts`
- Modify: `packages/messaging/src/responder.ts` (handoff variant), `respondStore.ts` (`markAwaitingHuman`), `respondToInboundMessage.ts` (both handoff paths), `resumeConversation.ts` (null the column), `index.ts` (exports)
- Test: `packages/messaging/tests/respondToInboundMessage.test.ts`, `tests/respondStore.test.ts`, `tests/resumeConversation.test.ts`, `tests/support/fakeRespondStore.ts`

**Interfaces:**
- Produces (in `dealAlert.ts`, exported from the package):
  ```ts
  export interface AlertScope { crmClientId: string; verified: boolean; conversationId: string }
  export interface DealAlertPort {
    /** dealId if it is an open deal of the client in scope, else the client's most recently updated open deal in scope, else null. */
    resolveAlertDeal(scope: AlertScope, dealId?: string): Promise<string | null>;
    setDealWaiting(dealId: string): Promise<void>;
  }
  ```
- `ResponderResult` handoff becomes `{ kind: "handoff"; summary: string; dealId?: string; linkedCustomer?: LinkedCustomer }`.
- `RespondStore.markAwaitingHuman(conversationId, handoff: { summary: string; handoffAt: string; dealId: string | null })` writes `handoff_deal_id`.
- `RespondDeps` gains `dealAlerts?: DealAlertPort` and `onAlertError?: (error: unknown) => void`.
- `resumeConversation` also sets `handoff_deal_id: null`.

- [ ] **Step 1: Failing tests** in `respondToInboundMessage.test.ts`:
  - `marks the subject deal waiting on handoff`: verified customer, result `{ kind: "handoff", summary: "s", dealId: "d-1" }`, fake `dealAlerts.resolveAlertDeal` → `"d-1"` → expect `resolveAlertDeal({ crmClientId, verified: true, conversationId: "conv-1" }, "d-1")`, `markAwaitingHuman(..., { summary: "s", handoffAt, dealId: "d-1" })`, `setDealWaiting("d-1")`.
  - `handoff still goes through when the alert fails`: `resolveAlertDeal` rejects → status `handoff`, `markAwaitingHuman` with `dealId: null`, notice sent, `onAlertError` called once.
  - `unregistered customer hands off without touching deals`: `resolveAlertDeal` not called, `dealId: null`.
  - `failure handoff marks the latest deal`: `handOffAfterFailure` with inbound `crmClientId: "crm-1", crmLinkVia: "cpf"` → `resolveAlertDeal({ crmClientId: "crm-1", verified: false, conversationId }, undefined)`.
  - `respondStore.test.ts`: `markAwaitingHuman` sends `handoff_deal_id`. `resumeConversation.test.ts`: update includes `handoff_deal_id: null`.
- [ ] **Step 2: Run** `cd packages/messaging && npx vitest run` — new tests fail.
- [ ] **Step 3: Implement.** In both handoff paths: build scope only when the customer is registered (`verified = crmLinkVia !== "cpf"` in the failure path; from `identifyCustomer` in the normal path); `resolveAlertDeal` inside try/catch (`onAlertError`) **before** `markAwaitingHuman`; `setDealWaiting` after `markAwaitingHuman`, also try/catch. Lock checks stay where they are.
- [ ] **Step 4: Run** messaging tests + `npx tsc --noEmit -p .` — all pass.
- [ ] **Step 5: Commit** `feat(messaging): mark the subject deal when a conversation is handed off`.

### Task 3: Agent — `negocio_id` on handoff + CRM adapter for alerts — fmagentes

**Files:**
- Modify: `packages/agent/src/tools/handoff.ts`, `src/LlmResponder.ts`, `src/crm/records.ts`, `src/crm/CrmPort.ts`, `src/buildPrompt.ts` (one rule line)
- Test: `tests/LlmResponder.test.ts`, `tests/supabaseCrm.test.ts`, `tests/buildPrompt.test.ts`, `tests/support/fakeCrm.ts`

**Interfaces:**
- Consumes: `DealAlertPort`, `AlertScope` (Task 2).
- Produces: `handoffTool` params `{ resumo: string; negocio_id?: string }` (via `toolArgs`); `LlmResponder` returns `dealId` = trimmed `negocio_id` when present; `CrmPort` extends `DealAlertPort` and `createSupabaseCrm` implements `resolveAlertDeal`/`setDealWaiting`.
- Prompt rule (exact): `- Ao transferir, informe em negocio_id o negócio do assunto da conversa (da lista Negócios abertos ou o que você acabou de registrar).`

- [ ] **Step 1: Failing tests:**
  - LlmResponder `passes the handoff deal through`: tool call `transferir_para_humano { resumo: "r", negocio_id: "d-1" }` → `{ kind: "handoff", summary: "r", dealId: "d-1" }`; without `negocio_id` → no `dealId` key.
  - supabaseCrm `resolveAlertDeal keeps an open deal in scope` (id found with `client_id`, `stage` not last → returns it), `resolveAlertDeal ignores out-of-scope and closed ids` (falls back to the newest open deal: query ordered `updated_at desc`, `limit 1`, filtered `client_id`, excluding each pipeline's last stage like `loadSnapshot`), `resolveAlertDeal on unverified link only sees this conversation's deals` (`created_by_conversation = conv-1` on both queries), `returns null when the client has no open deal`, `setDealWaiting writes only attention columns` (update payload exactly `{ attention: "waiting", attention_since: <iso>, attention_by: null }`, `eq("id", …)`).
  - buildPrompt: the new rule line is in `PLATFORM_INSTRUCTIONS`.
- [ ] **Step 2: Run** `cd packages/agent && npx vitest run` — fail.
- [ ] **Step 3: Implement** in `records.ts` reusing `scoped()` and `lastStage()`; a malformed (non-UUID) `dealId` skips straight to the fallback.
- [ ] **Step 4: Run** agent tests + `tsc` — pass.
- [ ] **Step 5: Commit** `feat(agent): name the subject deal on handoff and resolve it in the CRM`.

### Task 4: API — assign / unassign / resume update the card — fmagentes

**Files:**
- Create: `apps/api/src/dashboard/dealAttention.ts`
- Modify: `apps/api/src/dashboard/store.ts` + `supabaseStore.ts` (read `handoff_deal_id`), `routes/inbox.ts` (assign, unassign), `routes/conversations.ts` (resume), `app.ts` (deps), `index.ts` (wire with the existing CRM client)
- Test: `apps/api/tests/inbox.test.ts`, `tests/conversations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DealAttentionPort {
    setInService(dealId: string, attendantName: string): Promise<void>;
    setWaiting(dealId: string): Promise<void>;
    clear(dealId: string): Promise<void>;
  }
  export function createSupabaseDealAttention(crm: SupabaseClient): DealAttentionPort;
  ```
  Writes only `attention`, `attention_since` (now ISO, or null on clear), `attention_by`.
- `DashboardStore.handoffDealOf(conversationId: string): Promise<string | null>`.
- `AppDependencies.dealAttention?: DealAttentionPort` (absent when CRM env vars are missing).

- [ ] **Step 1: Failing tests:**
  - `assign marks the handoff deal in service with the attendant name` (name from `displayNames`, fallback e-mail — same value the route already returns).
  - `unassign puts the card back to waiting`.
  - `resume clears the card before resuming` (`clear` called with the id read **before** `resumeConversation`).
  - `assign without handoff deal does not touch the CRM`.
  - `assign still answers 200 when the CRM fails` (port rejects → 200, error logged).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run` — fail (Redis must be up: `docker compose up -d redis`).
- [ ] **Step 3: Implement** — in each route, after the existing successful outcome: read `handoffDealOf`, call the port in try/catch with `app.log.warn`.
- [ ] **Step 4: Run** API tests + `tsc` — pass.
- [ ] **Step 5: Commit** `feat(api): reflect assign, release and resume on the CRM card`.

### Task 5: Worker wiring — fmagentes

**Files:**
- Modify: `apps/worker/src/deps.ts`
- Test: `apps/worker/tests/deps.test.ts`

- [ ] **Step 1: Failing test** `wires the CRM as deal alerts`: `createWorkerDeps(...)` returns `dealAlerts` (the same CRM adapter used for `customerDirectory`) and an `onAlertError` function.
- [ ] **Step 2: Run** — fail. **Step 3:** pass `dealAlerts: crm, onAlertError: (e) => console.warn("[worker] deal alert failed", e)`. **Step 4:** worker tests + `tsc` pass; full `npx turbo test` green (Redis up).
- [ ] **Step 5: Commit** `feat(worker): mark the CRM card when a conversation is handed off`.

### Task 6: CRM board — paint and auto-refresh — CRM repo

**Files:**
- Modify: `C:\Users\Dell\Desktop\aula\app\dashboard\pipeline\page.tsx` (`Deal` type + `DEAL_COLUMNS` add `attention`, `attention_since`, `attention_by`), `PipelineBoard.tsx` (`DealCard`, `DragOverlay`, refresh), `app/globals.css` only if a blue/red token is missing.
- Create: `C:\Users\Dell\Desktop\aula\lib\attention.ts`

**Interfaces:**
- Produces: `attentionLabel(deal: Pick<Deal,'attention'|'attention_since'|'attention_by'|'stage'|'pipeline'>, now: Date): { tone: 'waiting' | 'in_service'; text: string } | null` — null when no attention or the deal is in its pipeline's last stage.

- [ ] **Step 1:** Implement `attentionLabel` with the exact copy from Global Constraints (minutes = floor((now − attention_since)/60000)). The CRM has no unit-test runner: verify with `npx tsc --noEmit` and the manual check in Task 7.
- [ ] **Step 2:** `DealCard`/`DragOverlay`: when `attentionLabel` is not null, red tone (`--destructive`) or blue tone (`--primary`/`--chart-2`) border-left + tinted background + a line with the text; readable in light and dark.
- [ ] **Step 3:** Auto-refresh: `setInterval(router.refresh, 30_000)` in `PipelineBoard`, skipped while a drag is active (existing drag guard) or a deal dialog is open; cleared on unmount. Recompute "há X min" on each refresh.
- [ ] **Step 4:** `npx tsc --noEmit -p .` and `npx next lint --dir app/dashboard/pipeline --dir lib` clean.
- [ ] **Step 5: Commit** (CRM) `feat(funis): cards destacam cliente esperando atendente`.

### Task 7: Apply and verify end to end — needs the owner

- [ ] **Step 1:** Ask the owner for "ok" to apply 015 to CRM production; on yes, `apply_migration` `015_deal_attention`, then verify the columns exist and `has_column_privilege('authenticated', …, 'UPDATE')` is false. Apply `0008_handoff_deal` to `odqqiteoskmfpwrlqyrb`.
- [ ] **Step 2:** Merge `feat/alerta-atendente` into CRM `main` (fast-forward) and fmagentes work into `master`; restart API and worker (owner runs the `nohup` commands); CRM dev server hot-reloads.
- [ ] **Step 3:** Owner test on WhatsApp: ask for a human → the subject card turns red within 30 s with "Esperando atendente · há …"; "Assumir" in the dashboard → blue "Em atendimento: {nome}"; "Soltar" → red; "Devolver ao robô" → normal. Check the worker log and `deals.updated_at` unchanged by the alert.
- [ ] **Step 4:** Push both repos only when the owner asks.
