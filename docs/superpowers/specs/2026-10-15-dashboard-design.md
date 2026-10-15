# Sub-project 5 — Dashboard completo — Design

**Date:** 2026-10-15
**Depends on:** Sub-project 4 (Núcleo do Agente/LLM) — merged, `master` at `2ab1c7f`.
**Roadmap context:** `docs/ROADMAP.md`. The dashboard today is a login page and
a health page; every operation exists only as an API route or SQL.

## Goal

A small team (2–5 people, same access level) runs the WhatsApp agents from the
browser:

1. **Inbox** — sees conversations the agent handed off, takes ownership
   ("Assumir"), replies, and gives the conversation back to the bot. Other bot
   conversations are visible read-only.
2. **Agents** — one agent per WhatsApp number: edits prompt, provider, model,
   handoff message, active flag; creates the agent for a number that has none.
3. **Numbers** — creates a number, pairs it by QR code, sees its status,
   removes it.

**Success:** an attendant logs in, sees within ~10 s that a customer was handed
off, takes it, answers from the panel, gives it back to the bot, and the bot's
next answer reflects what the human said. Editing an agent's prompt changes the
next answer.

## Scope

In:
- Migration 0005: assignment, human-message author, team display names.
- New API routes (all behind the existing auth + allowlist).
- Dashboard pages: inbox, agents, numbers, plus the existing status page, a
  shared layout and an API client.

Out (recorded so they are not relitigated):
- Canned replies, media, metrics/reports.
- User management in the panel — accounts are created by hand (Supabase Auth +
  `API_ALLOWED_USERS` + a `team_members` row).
- Per-user RLS in the database (still `using (true)`; the browser never talks to
  the fmagentes database directly, see Decision 1).
- WebSocket/Realtime — polling every 10 s.
- Taking over a conversation the bot has not handed off.
- Exclusive assignment (others may still reply, with a warning).

## Decisions

1. **The browser talks only to `apps/api`.** The API already verifies the
   Supabase access token, enforces the allowlist and holds the service key.
   Rejected: reading Supabase directly from the browser (needs real RLS, and a
   second permission source next to the allowlist); Next server actions with the
   service key (duplicates authorization, spreads the key).
2. **Same-origin proxy.** `next.config.js` rewrites `/api/:path*` to
   `${API_URL}/:path*`, so no CORS is needed. Every call carries
   `Authorization: Bearer <supabase access token>` from the browser session.
3. **Polling, not Realtime.** Client components refetch every 10 s while the
   tab is visible (`document.visibilityState`), and immediately after the
   user's own actions.
4. **"Assumir" is advisory.** Last click wins; nobody is blocked from replying.
   The panel warns before replying to an unassigned conversation or one owned
   by someone else.
5. **Display names come from a `team_members` table** keyed by Auth user id.
   Missing row → the panel shows the e-mail (from `GET /me` for oneself; for
   others the API returns the `team_members` name or, failing that, the user
   id's e-mail via the Auth admin API).
6. **The API reads the CRM** (customer name in the conversation detail) by
   reusing `packages/agent`'s CRM adapter. CRM env vars are optional in the
   API; without them the detail shows "cliente vinculado (nome indisponível)".
7. **A CPF-linked customer's name is never sent to the browser** — same rule as
   the agent: whoever typed the CPF may not own it. The panel shows a
   "CPF não verificado" badge instead.
8. **Provider availability** = which of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
   is set in the API's own env, assumed equal to the worker's (documented).
   Both become optional in the API env.
9. **Plain CSS Modules**, no component library; responsive (list and
   conversation become two screens on narrow viewports). UI text in Portuguese.

## Data model — migration `0005_dashboard.sql`

```sql
alter table conversations
  add column assigned_to uuid,          -- auth.users.id; no FK (auth schema)
  add column assigned_at timestamptz;

alter table messages
  add column sent_by uuid;              -- auth.users.id of a human sender; null for bot/customer

create table team_members (
  user_id uuid primary key,             -- auth.users.id
  display_name text not null check (length(trim(display_name)) > 0),
  created_at timestamptz not null default now()
);
alter table team_members enable row level security;
create policy "authenticated_full_access" on team_members
  for all to authenticated using (true) with check (true);

create index idx_conversations_status_last on conversations (status, last_message_at);
```

`resumeConversation` also clears `assigned_to` / `assigned_at`.

## API

All routes below live in the authenticated scope (401 no/invalid token, 403 not
allowlisted). Input validated with zod; a malformed UUID path param → 404.
Max lengths: reply text 4096, system prompt 20000, handoff message 1000,
agent name 100, model 100.

| Route | Behaviour |
|---|---|
| `GET /me` | `{ id, email, displayName, providers: { anthropic: bool, openai: bool } }` |
| `GET /conversations?view=handoff\|all\|mine` | `handoff` (default): `status = awaiting_human`, oldest `handoff_at` first. `mine`: handoff ∩ `assigned_to = me`. `all`: `status = open`, newest `last_message_at` first, limit 100. Each item: `id, contactPhone, instance {id, name}, status, handoffSummary, handoffAt, assignedTo {id, displayName} \| null, lastMessage {direction, content (≤140 chars), createdAt}, awaitingReply (last message is inbound), crmLinkVia`. Response also carries `counts: { handoff, mine }`. |
| `GET /conversations/:id` | The item fields plus `messages` (latest 100, chronological: `id, direction, role, content, createdAt, sentBy {id, displayName} \| null`) and `customer`: `{ linkVia: null }` / `{ linkVia: 'phone'\|'created', name \| null }` / `{ linkVia: 'cpf', unverified: true }`. CRM failure → `name: null`, never a 5xx. |
| `POST /conversations/:id/assign` | Sets `assigned_to = me`, `assigned_at = now()`; returns the new `assignedTo`. 409 if the conversation is not `awaiting_human`. |
| `POST /conversations/:id/unassign` | Clears both fields (anyone may unassign). |
| `POST /conversations/:id/messages` | Existing route; now records `sent_by = me` (`sendMessage` gains optional `sentBy`). |
| `POST /conversations/:id/resume` | Existing; now also clears assignment. |
| `GET /agents` | One row per instance: `{ instance {id, name, status}, agent \| null }`; agent = the instance's oldest active agent, else its newest agent. |
| `POST /agents` | Body `{ instanceId, name, provider, model, systemPrompt, handoffMessage?, isActive }`; 409 if the instance already has an agent. |
| `PUT /agents/:id` | Same fields minus `instanceId`; full replace. Deactivating is allowed (the bot then stays silent on that number — the form warns). |
| `GET/POST/DELETE /instances…` | Existing routes, unchanged. |

`provider` ∈ `anthropic`, `openai`. Saving a provider whose key is missing is
allowed but the response carries `warning: "provider-key-missing"` and the form
shows it.

## Dashboard

- `lib/api.ts` — `apiFetch(path, init)`: gets the session's access token from
  the Supabase browser client, calls `/api${path}`, parses JSON, on 401 signs
  out and redirects to `/login`, throws `ApiError(status, body)` otherwise.
- `lib/usePolling.ts` — fetch + 10 s interval while visible + `refresh()`.
- Layout `app/dashboard/layout.tsx`: sidebar (Inbox, Agentes, Números, Status),
  current user's name, Sair. Document title prefixed with `(N)` when N handoff
  conversations exist.
- **Inbox** `app/dashboard/inbox` — tabs Transferidas (default, with count) /
  Minhas / Todas; list on the left, conversation on the right
  (`?c=<id>` in the URL). Conversation pane: customer header (name / "CPF não
  verificado" badge / number), handoff summary, owner + Assumir/Soltar, history
  (bot, customer, human with author name), reply box (handoff conversations
  only), "Devolver ao bot" with confirmation. A failed send keeps the text and
  shows "Tentar de novo". Rules for the reply box live in a pure function
  `replyGate(conversation, me)` → `'assume-first' | 'warn-other-owner' | 'ok' |
  'read-only'`.
- **Agentes** `app/dashboard/agents` — table of numbers with their agent;
  form (name, provider select, model input with datalist `claude-haiku-4-5`,
  `gpt-4o-mini`, prompt textarea, handoff message, active toggle); "Criar
  agente" when none; provider-key warning from `/me`.
- **Números** `app/dashboard/instances` — list (name, paired phone, status);
  "Novo número" → name → QR shown; "Ver QR" polls status every 10 s until
  `connected`; "Remover" requires typing the name and states that all its
  conversations and messages are deleted (FK cascade).
- Existing status page stays at `/dashboard` (renamed "Status" in the nav).

## Error handling

- CRM missing/down → detail shows "nome indisponível"; list unaffected.
- Evolution down on send → 502; UI keeps the text, offers retry.
- Assign race → last write wins; the loser sees the new owner on next poll.
- Session expired → 401 → login.
- Instance removal deletes its conversations/messages (existing cascade);
  confirmation says so.

## Testing

- **API** route tests with in-memory/mocked Supabase and CRM (existing style):
  auth 401/403 on each new route; list filters/order/counts/awaitingReply;
  detail with phone/created/cpf/no link and CRM failure; assign/unassign (409
  when not awaiting_human); `sent_by` recorded; agent create/update validation,
  409 duplicate, provider warning; `/me` providers.
- **messaging**: `sendMessage` writes `sent_by`; `resumeConversation` clears
  assignment.
- **dashboard** (Vitest, pure logic): `apiFetch` (token header, 401 path,
  ApiError), `replyGate`, phone/time formatting.
- **Manual e2e** in the browser with the Evolution stub: handoff appears within
  10 s → Assumir → reply (author shown) → Devolver ao bot → customer message →
  bot answer reflects the human reply; edit agent prompt → next answer changes;
  create number → QR shown.

## Known gaps (carried forward)

- Everything listed under Scope → Out.
- Provider availability is inferred from the API's env, not the worker's.
- `fromMe` messages (human replying from the phone) still not persisted, so they
  do not appear in the inbox.
