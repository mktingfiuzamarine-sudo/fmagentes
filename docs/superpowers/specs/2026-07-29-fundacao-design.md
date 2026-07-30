# Fundação — Agente de IA para WhatsApp (Evolution API)

**Data:** 2026-07-29
**Sub-projeto:** 1 de N (Fundação) — parte de uma plataforma maior de agentes de IA que respondem via WhatsApp através da Evolution API.

## Contexto e escopo geral do projeto

O sistema completo terá os seguintes sub-projetos (specs/planos separados):

1. **Fundação** (este documento) — monorepo, schema base do Supabase, conexão Redis, esqueleto de API/worker/dashboard, autenticação.
2. **Integração Evolution API** — receber e processar webhooks reais, enviar mensagens, gerenciar instâncias.
3. **Fila/Worker (BullMQ)** — jobs de negócio reais (processar mensagem recebida, gerar resposta, enviar resposta).
4. **Núcleo do Agente/LLM** — lógica de IA, prompts, gerenciamento de contexto de conversa.
5. **Dashboard completo** — inbox funcional, gestão de agentes, gestão de instâncias Evolution API.

Este spec cobre **apenas o sub-projeto 1 (Fundação)**: o objetivo é ter uma base rodando localmente sem nenhum erro, sobre a qual os próximos sub-projetos serão construídos.

## Objetivo da Fundação

Entregar o esqueleto completo do sistema — monorepo, banco de dados, fila e autenticação — funcionando ponta a ponta em ambiente de desenvolvimento, com um teste de fumaça validando que todas as peças se conectam corretamente. Nenhuma lógica de negócio real (processamento de mensagens, IA respondendo) faz parte deste sub-projeto.

## Decisões técnicas

- **Linguagem/runtime:** Node.js + TypeScript em todo o backend (API, worker, dashboard).
- **Monorepo:** pnpm workspaces + Turborepo.
- **API HTTP:** Fastify.
- **Dashboard:** Next.js (React), com Supabase Auth (email/senha) para login.
- **Fila:** BullMQ, com worker rodando como processo separado do da API.
- **Redis:** Docker local via `docker-compose` (dev). Trocável para serviço cloud (ex. Upstash) em produção via variável de ambiente, sem mudança de código.
- **Banco de dados:** novo projeto Supabase dedicado (criado do zero, não reaproveitando projetos existentes na conta).
- **Evolution API:** instância já está rodando externamente (self-hosted); Fundação só valida conectividade, não processa webhooks reais ainda.
- **LLM:** múltiplos provedores via Vercel AI SDK (Anthropic e OpenAI configuráveis por agente), abstraídos atrás de uma função `getModel(provider, modelName)`.
- **Validação de ambiente:** `zod`, fail-fast — processo derruba no boot com mensagem clara se faltar variável obrigatória.
- **Testes:** Vitest em cada app/package.

## Arquitetura

```
fmagentes/
├── apps/
│   ├── api/          # Fastify + TS — REST API, recebe webhooks Evolution API
│   ├── worker/        # BullMQ worker — processo separado, consome filas
│   └── dashboard/      # Next.js — login e tela de status (inbox/gestão vêm depois)
├── packages/
│   ├── shared/        # tipos TS, clientes (Supabase, Evolution API), config Vercel AI SDK
│   └── config/         # validação de env (zod) compartilhada
├── supabase/
│   └── migrations/     # schema versionado
├── docker-compose.yml  # Redis local
└── turbo.json
```

`api`, `worker` e `dashboard` rodam como processos independentes (`turbo run dev` sobe os três em paralelo).

## Componentes

### `packages/config`
Validação de env com `zod`. Cada app importa um schema tipado cobrindo pelo menos: `API_PORT`, `REDIS_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

### `packages/shared`
- Cliente Supabase (server-side, service key), tipado a partir do schema gerado.
- Cliente Evolution API: wrapper fino (`checkConnection`, `sendMessage`, `getInstanceStatus`).
- `getModel(provider, modelName)`: retorna o client do Vercel AI SDK para o provedor certo.
- Tipos compartilhados: `Instance`, `Agent`, `Conversation`, `Message`.

### `apps/api` (Fastify)
- `GET /health`: valida conexão com Supabase, Redis e Evolution API; retorna 503 com detalhe de qual serviço falhou (não derruba o processo).
- `POST /webhooks/evolution`: recebe e loga o payload (não processa ainda). Sempre responde 200, mesmo com payload malformado (log do erro), para evitar retry infinito da Evolution API.
- Endpoint de teste que enfileira um job dummy na `test-queue` do BullMQ.

### `apps/worker`
- Processo BullMQ separado, conectado ao mesmo Redis.
- `test-queue` com processor que loga e retorna sucesso — valida o pipeline api → redis → worker.

### `apps/dashboard` (Next.js)
- Login/logout via Supabase Auth (email+senha).
- Rota protegida (`/dashboard`) mostrando status dos serviços (consumindo `/health` da API).

## Schema Supabase (básico)

- **`instances`**: `id`, `name`, `evolution_instance_id`, `status`, `phone_number`, `created_at`.
- **`agents`**: `id`, `name`, `provider`, `model`, `system_prompt`, `instance_id` (FK), `is_active`.
- **`conversations`**: `id`, `instance_id` (FK), `contact_phone`, `agent_id` (FK), `status`, `last_message_at`.
- **`messages`**: `id`, `conversation_id` (FK), `direction` (`in`/`out`), `content`, `role`, `evolution_message_id`, `created_at`.

RLS habilitado em todas as tabelas. Policy inicial: qualquer usuário autenticado via Supabase Auth tem acesso total (multi-tenant/permissões finas fica para um sub-projeto futuro — YAGNI aqui).

## Fluxo de dados (boot de desenvolvimento)

1. `docker-compose up -d` → sobe Redis.
2. `turbo run dev` → sobe `api`, `worker`, `dashboard` em paralelo.
3. Cada processo valida seu `.env` via `packages/config`; crasha imediatamente com mensagem clara se faltar variável (fail-fast).
4. Dev acessa `/health` na API → confirma Supabase, Redis e Evolution API respondendo.
5. Dev abre o dashboard, faz login (Supabase Auth), vê tela de status.
6. Teste ponta a ponta: API enfileira job dummy → worker consome e loga → prova que api ↔ redis ↔ worker funciona.

## Tratamento de erros

- Env inválido/faltante: crash no boot com mensagem específica da variável faltante (`zod` `safeParse` + `process.exit(1)`).
- Falha de conexão (Supabase/Redis/Evolution API) no `/health`: 503 com detalhe do serviço com falha, processo continua rodando.
- Webhook malformado: log do erro + resposta 200 (processamento real é do próximo sub-projeto).

## Testes

- Vitest em cada app/package.
- `packages/shared`: testes unitários dos wrappers (mockando fetch/Supabase client).
- `apps/api`: teste de integração de `/health` e do endpoint de enfileiramento (contra Redis real via Docker).
- `apps/worker`: teste de que o processor da `test-queue` roda e retorna sucesso.

## Critério de "pronto"

- `turbo run build && turbo run test` passam limpos.
- Fluxo de boot manual (seção "Fluxo de dados") funciona do início ao fim sem erro.
- `/health` reporta os três serviços (Supabase, Redis, Evolution API) como conectados.
- Login no dashboard funciona e mostra a tela de status.

## Fora de escopo (fica para sub-projetos futuros)

- Processamento real de webhooks da Evolution API.
- Lógica de IA / geração de respostas.
- Inbox funcional, gestão de agentes e gestão de instâncias no dashboard.
- Multi-tenancy / permissões finas.
- Deploy em produção.
