# Code review do monorepo — 2026-10-15 (master e13fb81)

Status: **parcial**. Das três revisões paralelas, só "API, shared, config e migrations" terminou.
As revisões de **messaging + worker + agent** e de **dashboard + mudança de CPF no CRM (aula bd5d646)**
foram interrompidas a pedido do usuário e precisam ser rodadas de novo.

## Verificação feita pelo controlador

- Cadastro público do Supabase fmagentes **aberto**: `GET /auth/v1/settings` → `disable_signup: false`,
  `mailer_autoconfirm: false` (exige confirmar e-mail, mas qualquer um confirma o próprio).
  Isso confirma a falha C1.
- Supabase security advisor: só "Leaked Password Protection Disabled" (WARN) —
  https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## API, shared, config e migrations

### Pontos fortes
- Auth fechada por construção: todas as rotas de consumidor num `register` encapsulado com o preHandler
  (`apps/api/src/app.ts`); falha de verificação → 401; allowlist vazia recusa boot.
- Token verificado por cliente anon separado (`apps/api/src/index.ts`).
- Nenhum filtro PostgREST montado a partir de input; ids validados com `isUuid`; `view` validada.
- Zod + limites nas entradas; preview cortado por code point; vínculo por CPF nunca expõe o nome.
- View `conversation_inbox` com `security_invoker = true`; constraints de idempotência e índices no lugar.
- Erros da Evolution → 502; timeout de 15 s no cliente; delete 404 idempotente.

### Crítica
**C1. RLS `using (true)` + anon key pública anulam a allowlist da API.**
`supabase/migrations/0001_init.sql:46-49`, `0005_dashboard.sql:24-25`. A anon key vai no bundle do dashboard
(`apps/dashboard/lib/supabase/client.ts`). Qualquer usuário `authenticated` tem `for all` em instances, agents,
conversations, messages e team_members direto pelo `/rest/v1/`, sem passar pela allowlist.
Cenário: estranho faz signup (aberto), confirma o próprio e-mail e lê todas as mensagens/telefones (LGPD),
reescreve `agents.system_prompt` (golpe em nome da empresa), apaga `instances` (cascata), edita `team_members`.
Correção:
```sql
-- 0006_lock_down_rest.sql
drop policy "authenticated_full_access" on instances;   -- idem agents, conversations, messages, team_members
revoke all on instances, agents, conversations, messages, team_members, conversation_inbox from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
```
(o dashboard não usa `.from(` — só Auth; o service role ignora RLS) + desligar o signup público
(Authentication → "Allow new users to sign up" = off) e criar usuários por convite.
O ROADMAP subestima isso como "sem isolamento de tenant".

### Importantes
**I1. Allowlist por e-mail não exige e-mail confirmado.** `apps/api/src/auth.ts` aceita `user.email` sem olhar
`email_confirmed_at`. Se "Confirm email" estiver desligado (ou troca de e-mail sem "secure email change"),
alguém se cadastra com o e-mail de um colega da allowlist que ainda não criou conta.
Correção: `email: data.user.email_confirmed_at ? data.user.email ?? null : null`; preferir ids na allowlist.

**I2. Webhook perde a mensagem se o enfileiramento falhar depois do insert.** `apps/api/src/routes/webhooks.ts`
+ `packages/messaging/src/ingestInboundMessage.ts`. Insert ok, `inboundQueue.add` falha (Redis) ou processo morre →
Evolution reenvia → upsert vê duplicata → `null` → nada enfileirado → cliente sem resposta, sem alerta.
Correção: no caminho de duplicata, buscar o id existente e enfileirar com `jobId: "in:" + messageId`
(BullMQ deduplica; o guard do worker já torna seguro). Ajustar `webhooks.test.ts` que cristaliza o comportamento atual.

**I3. `DELETE /instances/:id` ignora erro do banco e devolve 204** (`apps/api/src/routes/instances.ts`).
Evolution apaga, Supabase falha → linha órfã; QR dá 502; recriar com o mesmo nome bate no unique.
Também: `GET /instances` devolve `[]` em erro; `GET /instances/:id`, `/qr`, `DELETE` transformam erro em 404.
Correção: checar `error` em todas e devolver 500.

**I4. Sem rate limit; `/health` público amplifica chamadas** (`app.ts`, `routes/health.ts`). Cada `/health` faz query
no Supabase + `fetchInstances` na Evolution; cada Bearer qualquer chama `auth.getUser`.
Correção: `@fastify/rate-limit` (global por IP, mais apertado em /health); /health público só liveness;
cache curto de `getUser` por hash do token (opcional).

### Menores
- **M1** Segredo do webhook comparado com `!==` (`webhooks.ts`) → `crypto.timingSafeEqual`.
- **M2** `reply.send(error)` vaza mensagem do Postgres em 500 (`app.ts`) → em `statusCode >= 500` logar e responder `{ error: "internal error" }`.
- **M3** `POST /instances` só valida não-vazio; todo erro da Evolution vira 502 → zod `/^[\w-]{1,64}$/` e mapear 4xx da Evolution para 409/400.
- **M4** Updates de status ignoram `error` (`webhooks.ts` connection.update, `instances.ts` connecting) → checar e, no webhook, 500 para retry.
- **M5** Índice `messages_conversation_id_idx` (0002) redundante com `idx_messages_conversation_received` (0005); falta índice parcial `conversations(handoff_at) where status='awaiting_human'` quando crescer.
- **M6** `evolution_message_id` único global, não por instância (`0003`) → unique `(conversation_id, evolution_message_id)`.
- **M7** Cliente Supabase principal e o de auth da API sem `timeoutMs` (`index.ts`) → passar 10_000; comentário em `app.ts` para ninguém ligar CORS `origin: "*"`.

### Avaliação
Camada HTTP bem construída, mas C1 torna a allowlist decorativa enquanto as policies `using (true)` existirem
e o signup estiver aberto. Prioridade: C1 (migration de revoke + desligar signup) e I1 antes de expor o dashboard;
depois I2 e I3.

## Próximos passos
1. Rodar de novo as revisões de messaging/worker/agent e dashboard/CRM e completar este relatório.
2. Decidir com o usuário a correção de C1 (migration 0006 + desligar signup no painel do Supabase).
