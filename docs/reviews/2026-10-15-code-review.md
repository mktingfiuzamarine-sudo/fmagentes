# Code review do monorepo — 2026-10-15 (master e13fb81)

Status: **completo**. Três áreas: (1) API, shared, config e migrations; (2) messaging + worker + agent;
(3) dashboard + mudança de CPF no CRM (repo aula, commit bd5d646). As áreas 2 e 3 foram concluídas na retomada.

## Resumo por prioridade

| # | Gravidade | Área | Achado |
|---|---|---|---|
| C1 | Crítica | migrations | RLS `using (true)` + signup aberto anulam a allowlist da API |
| I1 | Importante | API | Allowlist não exige e-mail confirmado |
| I2 | Importante | API/messaging | Mensagem perdida se o enqueue falha depois do insert |
| I3 | Importante | API | `DELETE /instances` e leituras ignoram erro do banco |
| I4 | Importante | API | Sem rate limit; `/health` público amplifica chamadas |
| I5 | Importante | messaging | Bot responde em grupos, status e canais |
| I6 | Importante | messaging | Resposta duplicada ao cliente se o insert falha após o envio |
| I7 | Importante | worker | Supabase sem timeout + heartbeat do lock = conversa travada para sempre |
| I8 | Importante | worker/agent | Falha definitiva do LLM deixa o cliente sem resposta e sem handoff |
| I9 | Importante | CRM | Agente ignora o isolamento por usuário do CRM; CPF único global vira oráculo |
| M1–M18 | Menores | todas | ver seções |

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

## Messaging, worker e agent

### Pontos fortes
- Lock por conversa com nonce, renovação e release atômicos em Lua (`apps/worker/src/redisConversationLock.ts`);
  `isLost()` checado antes de cada efeito colateral.
- `ConversationBusyError` → `moveToDelayed` + `DelayedError` (não gasta tentativa); erro de configuração →
  `UnrecoverableError`.
- Marca d'água `answers_through` no relógio do banco com precisão de µs: rajadas de mensagens geram uma resposta só.
- Handoff persistido antes do envio do aviso, então o retry não chama o modelo de novo.
- Vínculo por CPF nunca expõe dados do cadastro ao modelo nem grava `phone` (só nota "não verificado").
- Ferramenta de cadastro só é oferecida a cliente não cadastrado; `maxRetries: 0` no SDK; timeout de 45 s no LLM
  e de 10 s no CRM.

### Importantes
**I5. Bot responde em grupos, status e canais.** `packages/messaging/src/events.ts:29` (`jidToPhone`) aceita qualquer
JID com `@`; o webhook só filtra `fromMe` (`apps/api/src/routes/webhooks.ts:22`).
Cenário: o número da empresa está num grupo → `120363…@g.us` vira `contact_phone`, o bot responde **no grupo**
em nome da empresa. `status@broadcast` vira contato `"status"` → chamada de LLM paga + `sendText` falha 3×.
Correção: em `parseEvolutionEvent`, aceitar só `@s.whatsapp.net` (e tratar `@lid` explicitamente — ver o bug de LID
da Evolution 2.3.1); ignorar `@g.us`, `@broadcast`, `@newsletter`. Teste para cada sufixo.

**I6. Resposta duplicada se o insert falha depois do envio.** `packages/messaging/src/sendMessage.ts:45-64`.
`sendText` entrega ao cliente → insert em `messages` falha (ou o processo morre) → job falha → retry →
`isAnswered` é falso (não há linha com `answers_through`) → o LLM roda de novo e o cliente recebe **duas** respostas
(possivelmente diferentes). O mesmo vale para o aviso de handoff.
Correção: inserir a linha de saída **antes** do envio (com `answers_through` e `evolution_message_id` nulo / status
`pending`), enviar, depois atualizar com o id da Evolution; se o envio falhar, apagar a linha. Assim o retry vê a
resposta como dada (prefere-se "no máximo uma vez" a duplicar).

**I7. Conversa pode travar para sempre.** `apps/worker/src/index.ts:32` cria o cliente Supabase principal **sem**
`timeoutMs` (o do CRM tem). Um fetch pendurado nunca termina, mas o heartbeat do lock continua renovando
(`redisConversationLock.ts:66`) — o TTL de 30 s nunca expira. Todos os jobs seguintes da conversa recebem
`ConversationBusyError` e são re-agendados a cada 2 s indefinidamente (não gastam tentativa).
Correção: `timeoutMs: 10_000` no cliente principal do worker (e da API — M7); opcionalmente um teto de duração
do job (ex.: parar de renovar após 2 min) e um teto de re-agendamentos por busy.

**I8. Falha definitiva do LLM = silêncio para o cliente.** `apps/worker/src/inboundProcessor.ts:39-44`,
`packages/agent/src/LlmResponder.ts:96`. Sem crédito na Anthropic (situação atual — HTTP 400), provedor fora do ar,
modelo inexistente ou chave revogada: o job falha (após 3 tentativas ou direto como `UnrecoverableError`) e só
aparece um `console.error`. O cliente não recebe nada e a conversa não aparece em "Transferidas".
Correção: quando o job falhar de vez (`UnrecoverableError` ou `attemptsMade >= attempts` no evento `failed`),
marcar `awaiting_human` com resumo "Bot indisponível: <motivo>" e enviar o `handoffMessage`. Tratar o 400 de
saldo da Anthropic como erro de configuração.

### Menores
- **M8** `last_message_at` atualizado sem checar `error` (`ingestInboundMessage.ts:62`, `sendMessage.ts:68`) — a inbox
  ordena por ele.
- **M9** Sem limite de tamanho do texto recebido (WhatsApp aceita ~65 mil caracteres) → custo de tokens por
  mensagem; truncar (ex.: 4.000 caracteres) antes do prompt.
- **M10** Se o modelo gastar os 3 passos (`MAX_STEPS`) em chamadas de ferramenta, o texto vem vazio → `decline`
  silencioso. Logar e tratar como handoff.
- **M11** `isOwedHandoffNotice` (`respondToInboundMessage.ts:107`) compara com `Date.parse` (ms) enquanto o resto do
  fluxo usa µs (`internal/timestamps.ts`) — usar o mesmo helper.
- **M12** `attachPhone` faz leitura-modificação-escrita em `notes` (`supabaseCrm.ts:86-101`); duas conversas em
  paralelo podem perder uma linha. Baixa probabilidade; resolver com RPC ou `notes = notes || $1` no banco.

## Dashboard

### Pontos fortes
- O navegador só fala com `/api` no mesmo domínio (rewrite em `next.config.js`): API sem CORS.
- Nenhum `dangerouslySetInnerHTML`; conteúdo de mensagens renderizado como texto (sem XSS).
- 401 → logout e volta ao login; remoção de número exige digitar o nome; aviso de CPF não verificado na conversa.

### Menores
- **M13** Corrida no `usePolling` (`apps/dashboard/lib/usePolling.ts:29`): ao trocar de aba na inbox, uma resposta
  atrasada da aba anterior sobrescreve a nova — "Todas" pode mostrar a lista de "Transferidas" por até 10 s.
  Correção: contador de geração por `key`; descartar respostas de gerações antigas.
- **M14** `middleware.ts` usa a API de cookies `get/set/remove` (obsoleta no `@supabase/ssr` 0.5) e o `set` recria a
  response a cada chamada, descartando cookies já gravados. Com o token dividido em pedaços (`.0`, `.1`), o refresh
  pode salvar só o último → logout aleatório. Migrar para `getAll/setAll`.
- **M15** Usuário logado mas fora da allowlist recebe 403, que não é tratado: o painel fica em "Erro ao carregar" /
  "tentando de novo" para sempre. Mostrar "Sua conta não tem acesso" e sair.
- **M16** `getHealth` (server-side) sem timeout: a página Status fica pendurada se a API travar. Usar
  `AbortSignal.timeout(5000)`.
- **M17** Na aba "Transferidas", o shell e a inbox pedem `/conversations?view=handoff` a cada 10 s — requisição
  duplicada. Compartilhar o resultado (contexto) ou o shell pedir só as contagens.

## CRM (repo aula, commit bd5d646)

### Pontos fortes
- Validação de CPF correta e idêntica à do agente; máscara progressiva; `23505` vira mensagem amigável.
- `phone_digits` gerada (`GENERATED ALWAYS ... STORED`) — a aplicação nunca precisa mantê-la; CHECK de 11 dígitos.

### Importante
**I9. O agente ignora o isolamento por usuário do CRM.** No CRM, `clients` tem RLS por `user_id`
(`001_init.sql:212-216`) e a tela filtra `.eq('user_id', user.id)` — cada usuário vê só os seus clientes. Mas:
(a) o agente busca por telefone/CPF em **todos** os usuários com a service key (`packages/agent/src/crm/supabaseCrm.ts`)
e cumprimenta pelo nome um cliente que pertence a outro usuário; (b) clientes criados pelo agente ficam no
`CRM_AGENT_USER_ID` e ninguém mais os vê no CRM; (c) o índice único **global** de CPF (`009_...sql:12`) faz o
usuário A receber "CPF já cadastrado em outro cliente" para um CPF da carteira do usuário B — dá para testar se um
CPF existe na base de outra conta.
Correção depende do modelo de uso: se o CRM é **uma empresa com vários atendentes**, trocar as policies de
`clients` para acesso da equipe (e (a)/(c) deixam de ser problema); se são **contas independentes**, o agente
precisa filtrar por `user_id = CRM_AGENT_USER_ID` e o unique passa a ser `(user_id, cpf)`. **Decisão do usuário.**

### Menor
- **M18** `idx_clients_phone_digits` (btree) não serve para `LIKE '%sufixo'` usado pelo agente → varredura completa.
  Irrelevante com poucos clientes; quando crescer, índice em `reverse(phone_digits)` com `LIKE 'reverso%'` ou `pg_trgm`.
- Duplicação de `cpf.ts` entre os dois repos: aceitável hoje (repos separados), mas qualquer mudança precisa ir aos dois.

## Avaliação geral
O núcleo de mensageria é cuidadoso (lock, marca d'água, idempotência), e a camada HTTP é bem fechada.
Os riscos reais estão nas bordas: **C1** expõe tudo pela REST do Supabase; **I5** pode fazer o bot falar em grupos;
**I8** deixa clientes sem resposta hoje mesmo (Anthropic sem crédito); **I6/I7** aparecem sob falhas transitórias.

## Correções aplicadas
- **I5** — `parseEvolutionEvent` só aceita `@s.whatsapp.net`; `@lid` é resolvido por `remoteJidAlt`/`senderPn` ou ignorado.
- **I1** — `createSupabaseAuthPort` devolve `email: null` quando `email_confirmed_at` é nulo.
- **I7** — todos os clientes Supabase do worker com timeout de 10 s (`apps/worker/src/deps.ts`); lock para de renovar
  após 3 min (`DEFAULT_MAX_HOLD_MS`). Obs.: postgrest-js 2.111 refaz leituras sozinho (até 4×, backoff 1/2/4 s), então
  uma leitura pendurada termina em ~47 s, não em 10 s.
- **I8** — `handOffAfterFailure` (messaging) marca `awaiting_human` com resumo "Bot indisponível: …" e envia o
  `handoffMessage`; o worker chama em erro de configuração e na última tentativa. O 400 de saldo da Anthropic agora é
  erro de configuração.
- **I6** — `sendMessage` grava a linha de saída (com `answers_through`) **antes** do `sendText`; se o envio falha, apaga a
  linha; o `evolution_message_id` é gravado depois, sem falhar o envio. Ressalva: se o envio falha e o delete também, a
  resposta fica registrada sem ter sido entregue (preferimos “no máximo uma vez”).
- **I2** — em duplicata, `ingestInboundMessage` devolve os ids da linha já gravada e o webhook enfileira com
  `jobId: in-<messageId>` (`inboundJobId`). O `in:` sugerido acima não serve: o BullMQ 5 rejeita `:` em ids customizados.
- **I3** — `/instances` (lista, detalhe, `/qr`, `DELETE`) responde 500 em erro do banco; falha só ao gravar
  `connecting` no `/qr` vira log, porque o QR continua válido. Repetir o `DELETE` é seguro (Evolution trata 404 como apagado).

## Ordem sugerida de correção
1. **C1** — migration 0006 (revoke) + desligar signup no painel do Supabase. *Precisa de confirmação: muda o banco de produção.*
2. **I5** (filtro de JID) e **I8** (fallback para humano) — pequenos e de alto impacto.
3. **I1, I7** (uma linha cada), depois **I6, I2, I3**.
4. **I9** — depois de decidir o modelo de uso do CRM.
5. **I4** e menores.
