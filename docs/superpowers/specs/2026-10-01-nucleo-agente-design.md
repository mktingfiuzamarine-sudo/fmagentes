# Sub-project 4 — Núcleo do Agente/LLM — Design

**Date:** 2026-10-01
**Depends on:** Sub-project 3 (Fila/Worker) — merged, `master` at `78e1d24`.
**Roadmap context:** `docs/ROADMAP.md`. Sub-project 3 left `EchoResponder`
behind the `ResponderPort` seam; this sub-project puts a real model there, plus
the customer-registration flow against the existing CRM.

## Goal

An inbound WhatsApp message is answered by a real LLM (Anthropic or OpenAI,
chosen per agent) acting as a customer-service agent for the business. The
agent:

1. Knows whether the customer is already registered in the CRM (looked up by
   phone, in code, before the model is called).
2. If not registered, collects **name, CPF and e-mail** (all required) and
   registers the customer in the CRM through a tool.
3. Answers questions from the business knowledge written in the agent's
   `system_prompt`.
4. Hands the conversation off to a human — after collecting the basics, unless
   the customer insists — through a tool. The bot then stops answering that
   conversation until a human resumes it.

It also pays down the two debts sub-project 3 deferred here: the duplicate
guard's two-clock comparison and the conversation lock's missing renewal.

## Scope

**In scope**
- New package `packages/agent`: `LlmResponder` (implements `ResponderPort`),
  prompt building, the two tools, `CrmPort` + Supabase adapter.
- `ResponderPort` contract change (`reply` / `handoff` / `decline`).
- Handoff state on conversations; `POST /conversations/:id/resume`.
- CRM lookup before the model call; `cadastrar_cliente` tool.
- Configurable history window (`AGENT_HISTORY_LIMIT`, default 30).
- `messages.received_at` and the guard rewritten on top of it.
- Lock heartbeat/renewal; LLM call timeout.
- **CRM repository (`C:\Users\Dell\Desktop\aula`, GitHub
  `mktingfiuzamarine-sudo/agentes_ia`)**: `cpf` + `phone_digits` columns, CPF
  in the client form and table, the fixed "Agente WhatsApp" user.

**Out of scope**
- RAG / knowledge base (future sub-project; it will plug in as another tool).
- Multi-tenant ownership and real RLS (future sub-project).
- Creating a CRM *deal* automatically on registration (future tool).
- Persisting messages a human sends from the paired phone (`fromMe`) — see
  Known gaps.
- Conversation summarisation of old history.
- Dashboard UI for the inbox / resume button (sub-project 5).
- Upgrading the VPS Evolution API (LID bug) — verification uses a local stub.

## Decisions

Recorded with the rejected options so they are not relitigated.

1. **Use case: customer service for one business**, built so multi-tenant (B)
   and acting agents (C) stay additive. Rejected for now: multi-tenant, which
   needs ownership + RLS, not agent-core work.
2. **Handoff stops the bot.** The agent sends a notice, the conversation becomes
   `awaiting_human`, and stays silent until resumed. Rejected: generic "I'll get
   back to you" while continuing; no handoff at all.
3. **Knowledge lives in the agent's prompt** (a few pages). RAG later, as a tool.
4. **Memory = last N messages** (`AGENT_HISTORY_LIMIT`, default 30), regardless
   of age. Rejected: time-boxed sessions; rolling LLM summary (can be added
   later without breaking anything).
5. **Both providers, chosen per agent** (`agents.provider` / `agents.model`),
   validated first with Anthropic (Claude Haiku 4.5).
6. **Handoff via tool calling.** Rejected: a text marker (fragile, can leak to
   the customer, no seam for future tools); a separate classifier call (double
   cost and latency).
7. **Collect basics before handing off.** The handoff tool carries a `resumo`
   that the human reads. An explicit request for a human always wins, even
   before registration.
8. **CRM registration.** Identification is deterministic code (phone lookup);
   registration is the model plus a tool whose input the code validates.
   Required fields: name, CPF, e-mail. Owner of agent-created clients: one fixed
   CRM user (`CRM_AGENT_USER_ID`). The CRM is accessed directly through its own
   Supabase project with its service key, behind a `CrmPort` so an API can
   replace the adapter later.

## Architecture

```
webhook → inbound-messages queue → worker → respondToInboundMessage
  ├ lock (with heartbeat)
  ├ load inbound + conversation
  ├ conversation awaiting_human?
  │    ├ pending handoff (see Handoff) → send handoff notice, done
  │    └ otherwise → skipped: awaiting-human
  ├ resolve agent                        (unchanged)
  ├ duplicate guard on received_at
  ├ load last N messages
  ├ CRM identification (if conversation has no crm_client_id)
  └ responder.generate(...)
       ├ reply   → sendMessage(text)
       ├ handoff → persist handoff state, then send agent.handoff_message
       └ decline → skipped: responder-declined
```

### Package boundaries

- **`packages/messaging`** stays LLM-free and CRM-free. It orchestrates and owns
  persistence of conversations/messages. It defines a narrow
  `CustomerDirectoryPort { findByPhone(phone), findById(id) }` (both
  `Promise<{ id, name } | null>`)
  and receives an implementation (plus the responder) through `RespondDeps`.
  It is the only writer of `conversations.crm_client_id` / `crm_link_via`.
- **`packages/agent`** (new) depends on `@fmagentes/shared` (`getModel`) and the
  Vercel AI SDK. Units:
  - `buildPrompt(input)` — system prompt = platform instructions + customer
    context block + `agent.systemPrompt`; history → SDK message list.
  - `tools/handoff.ts` — `transferir_para_humano({ resumo: string })`.
  - `tools/registerCustomer.ts` — `cadastrar_cliente({ nome, cpf, email })`.
  - `cpf.ts` — normalisation + check-digit validation (pure).
  - `crm/CrmPort.ts` + `crm/supabaseCrm.ts` — the CRM adapter; it also
    satisfies messaging's `CustomerDirectoryPort`.
  - `LlmResponder` — wires the above into one `generateText` call.
- **`apps/worker`** composition root builds `LlmResponder` and the CRM adapter.
- **`apps/api`** gains the resume route.

### Contract change: `ResponderPort`

```ts
type LinkedCustomer = { crmClientId: string; via: "cpf" | "created" };

type ResponderResult =
  | { kind: "reply"; text: string; linkedCustomer?: LinkedCustomer }
  | { kind: "handoff"; summary: string; linkedCustomer?: LinkedCustomer }
  | { kind: "decline"; linkedCustomer?: LinkedCustomer };

interface ResponderInput {
  agent: AgentConfig;          // gains handoffMessage
  history: HistoryMessage[];
  incoming: HistoryMessage;
  conversationId: string;
  contactPhone: string;
  customer: CustomerContext;   // { status: "registered", name?: string } | { status: "unregistered" }
}
```

`EchoResponder` is adapted (returns `reply` / `decline`) and kept for tests.
The responder may register/link a customer in the CRM during the call (via the
tool). It reports that through `linkedCustomer`; `respondToInboundMessage`
writes `crm_client_id` and `crm_link_via` before sending. The agent package
never writes to the fmagentes database.

### `LlmResponder.generate`

- One `generateText` call: model from `getModel(provider, model)`, system
  prompt, messages, tools `{ transferir_para_humano, cadastrar_cliente }`,
  max 3 steps (tool → tool result → final text), `abortSignal` timeout 45 s.
- Anthropic: system prompt sent with prompt caching (same text on every
  message of an agent). If the installed `ai` / `@ai-sdk/anthropic` versions
  cannot express this, the plan upgrades them.
- Result mapping:
  - handoff tool called in any step → `handoff` (any text is discarded; the
    customer gets `agent.handoff_message`);
  - else non-blank final text → `reply`;
  - else → `decline`.
- Errors:
  - transient (429, 5xx, timeout, network) → rethrow → BullMQ retry
    (3 attempts, existing backoff); after the last attempt the customer gets no
    reply and the failure is logged. No canned fallback message.
  - configuration (unknown provider, unknown model, 401/403) → BullMQ
    `UnrecoverableError` with a log naming the agent id.

### Prompt

Platform instructions (fixed, in code, Portuguese):
- You are answering on WhatsApp: short, plain messages, no markdown.
- Never invent information that is not in the business instructions; when you
  do not know, collect the basics and hand off.
- If the customer asks for a human, call `transferir_para_humano` immediately;
  if basics are missing, ask once, and if the customer insists, transfer anyway.
- Before transferring, collect what the business instructions list as needed
  and put it in `resumo`.
- Customer context block (generated per call):
  - registered → "Cliente cadastrado: {name}." (only for phone-matched clients;
    see Privacy);
  - unregistered → "Cliente SEM cadastro. Antes de prosseguir com o atendimento,
    peça nome completo, CPF e e-mail e chame `cadastrar_cliente`."

Then `agent.systemPrompt` (business knowledge and business-specific handoff
rules, written by the operator).

## Data

### fmagentes — migration `0004_agent_core.sql`

- `conversations.status`: `check (status in ('open','awaiting_human'))`
  (existing default `'open'` kept).
- `conversations.handoff_summary text`, `conversations.handoff_at timestamptz`.
- `conversations.crm_client_id uuid` (no FK — it points into the CRM's
  database) and `conversations.crm_link_via text check (crm_link_via in
  ('phone','cpf','created'))`.
- `agents.handoff_message text not null default 'Vou te passar para um
  atendente, já já alguém te responde.'`.
- `messages.received_at timestamptz not null default now()` (backfilled from
  `created_at` for existing rows by the default + an update in the migration).

### CRM — migration `009_client_cpf_and_phone_digits.sql` (repo `aula`)

- `clients.cpf text` — digits only, `check (cpf ~ '^[0-9]{11}$')`, partial
  unique index `where cpf is not null`.
- `clients.phone_digits text generated always as
  (regexp_replace(coalesce(phone,''), '\D', '', 'g')) stored` + index.
  Application code must never write it (same rule as `search_vector`).
- The fixed user "Agente WhatsApp" is created in the CRM's Auth (manual step,
  documented); its id goes into `CRM_AGENT_USER_ID`.

### CRM UI (repo `aula`)

Client form: CPF field with mask, zod validation of check digits, uniqueness
error surfaced. Clients table: CPF column. Whether CPF is required in the CRM
form for human-created clients: **optional** (existing clients have none).

## CRM integration

`CrmPort`:

```ts
interface CrmPort {
  findByPhone(phone: string): Promise<CrmClient | null>;
  findByCpf(cpf: string): Promise<CrmClient | null>;
  create(input: { name: string; cpf: string; email: string; phone: string }): Promise<CrmClient>;
  attachPhone(clientId: string, phone: string): Promise<void>;
}
```

- **Phone matching.** WhatsApp gives `55` + DDD + number. Strip `55`, then
  match `phone_digits` ending in the national number, trying both with and
  without the mobile ninth digit. More than one match → treat as not found
  (ambiguous) and log.
- **Identification** happens in `respondToInboundMessage` only when the
  conversation has no `crm_client_id`; a phone match writes `crm_client_id`
  with `crm_link_via = 'phone'` and later messages skip the lookup (the name
  for the context is then fetched by id). Registered-by-phone clients get the
  "Cliente cadastrado: {name}" context.
- **`cadastrar_cliente`** (tool `execute`):
  1. Validate CPF check digits and e-mail format; invalid → return an error
     string to the model, which asks the customer again. Nothing written.
  2. `findByCpf` hit → `attachPhone`: if the CRM client's `phone` is empty,
     set it; otherwise append `Outro WhatsApp: {phone}` to `notes` unless
     `notes` already contains that number (retry-safe). Nothing else is
     overwritten. Result `linkedCustomer: { via: "cpf" }`; the tool returns
     "cadastro vinculado" with **no** stored data.
  3. Miss → `create` with owner `CRM_AGENT_USER_ID`. Result
     `linkedCustomer: { via: "created" }`; the tool returns "cadastro criado".
  4. CRM unavailable → throw (job retries; the whole message is regenerated).
     If a create succeeded before the failure, the retry's phone lookup finds
     the new client, so no duplicate is created.
- **Privacy (LGPD).** Anyone can type someone else's CPF. A CPF-linked
  conversation (`crm_link_via = 'cpf'`) never receives the stored client's
  data: the tool returns no fields, and on later messages the customer context
  is "registered" **without a name** (the model keeps using what the customer
  said). Only `phone` and `created` links expose the name.

Env (worker): `CRM_SUPABASE_URL`, `CRM_SUPABASE_SERVICE_KEY`,
`CRM_AGENT_USER_ID`, plus `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`AGENT_HISTORY_LIMIT` (optional, default 30).

## Handoff

Order, chosen for retry safety:

1. Persist `status = 'awaiting_human'`, `handoff_summary`, `handoff_at = now()`.
2. Send `agent.handoff_message` via `sendMessage`.

If step 2 fails, the retry finds the conversation `awaiting_human` with the
triggering inbound `received_at <= handoff_at` and no `out` message after it:
that is a **pending handoff**, and the job only sends the notice — no model
call. Any inbound received after `handoff_at` is skipped with reason
`awaiting-human`.

**Resume:** `POST /conversations/:id/resume` (authenticated scope) sets
`status = 'open'`, clears `handoff_summary` / `handoff_at`. 404 if the
conversation does not exist; idempotent if already open. Messages a human sent
through `POST /conversations/:id/messages` are already persisted as `out`, so
the agent sees them in history after resume.

`RespondResult` gains `{ status: "handoff" }` and skip reason `awaiting-human`.

## Debt paid from sub-project 3

- **Two clocks.** The duplicate guard compares the inbound's `received_at`
  (DB `now()`) with outbound `created_at` (DB `now()`). The device timestamp no
  longer participates. History ordering keeps using `created_at`.
- **Lock without renewal.** `ConversationLock.acquire` returns a handle that
  renews the TTL (Lua, nonce-checked, `PEXPIRE`) every ~TTL/3 while held. A
  failed renewal marks the handle lost; `respondToInboundMessage` checks
  `handle.isLost()` right before any send / handoff persist and throws if lost
  (the job retries; the guard protects the retry). The heartbeat stops on
  release.

## Testing

- **`packages/agent`** — unit tests with the AI SDK mock language model (no
  network, no cost): reply; handoff; handoff + text (handoff wins); decline on
  blank; transient error rethrown; configuration error → unrecoverable;
  `cadastrar_cliente` invalid CPF / invalid e-mail / CPF hit (link, no data
  returned, phone vs notes) / CPF miss (create with agent owner). `cpf.ts`
  pure tests. `buildPrompt` for both customer contexts. Supabase CRM adapter
  phone matching (with/without ninth digit, ambiguous) against a mocked client.
- **`packages/messaging`** — existing tests moved to the new contract; new:
  skip `awaiting-human`; handoff persists then sends; pending-handoff retry
  sends only the notice; guard on `received_at`; history limit honoured; CRM
  identification writes `crm_client_id` once; lost lock aborts before send.
- **`apps/worker`** — lock heartbeat against real Redis: held past the TTL
  stays owned; renewal after expiry/steal reports lost.
- **`apps/api`** — resume route: 401 without auth, 404 unknown, 200 + state
  cleared.
- **CRM repo** — migration applied; form validation of CPF; uniqueness error.
- **End-to-end (manual, recorded in ROADMAP)** — real LLM (Claude Haiku 4.5),
  real fmagentes + CRM databases, Evolution replaced by the local stub (LID
  bug). Scenarios:
  1. New phone → agent asks name/CPF/e-mail → client created in the CRM with
     the agent owner → question answered from the prompt.
  2. Known phone → greeted by name, no registration asked.
  3. Customer asks for a human → basics collected (or insisted) → notice sent,
     conversation `awaiting_human` with a summary; next inbound skipped.
  4. Resume → agent answers again and sees the human's messages in history.

## Known gaps (carried forward)

- `fromMe` messages (a human answering from the paired phone) are still not
  persisted. Doing it safely needs `sendMessage` to persist before (or
  atomically with) the Evolution send, because the webhook echo of our own send
  can arrive before our insert and the unique `evolution_message_id` would turn
  the retry into a double send.
- `sendMessage` still sends before persisting (sub-project 3 debt).
- Failed-after-3-attempts LLM jobs leave the customer unanswered; no alerting.
- RLS `using (true)` in fmagentes; the CRM service key bypasses the CRM's RLS by
  design — guarded only by the worker running server-side.
- VPS Evolution 2.3.1 LID bug still blocks real sends.
