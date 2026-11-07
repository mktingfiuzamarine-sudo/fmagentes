# CRM Fiuza Marine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o CRM genérico em CRM da Fiuza Marine (4 funis com trava de etapa, ficha náutica com embarcações, números do Olist, todos veem tudo) e dar à IA do WhatsApp ferramentas para gravar ficha, embarcações e negócios aos poucos.

**Architecture:** Parte A no repositório do CRM (`C:\Users\Dell\Desktop\aula`): três migrações SQL (clientes, embarcações, funis) com a regra de obrigatoriedade dentro do RPC `move_deal_to_stage`, e telas Next.js lendo um catálogo TS que espelha os CHECKs do banco. Parte B no fmagentes: `CustomerContext` passa a carregar o id do cliente e se o vínculo é verificado; o pacote `agent` ganha um retrato do CRM no prompt, uma função pura de "preencher só o vazio" e três ferramentas novas. A IA escreve com a service key, sempre com compare-and-swap em `updated_at`.

**Tech Stack:** Postgres/Supabase (RLS, RPC plpgsql), Next.js 15 + React 19 + react-hook-form + zod + dnd-kit (CRM), TypeScript + Vercel AI SDK `tool()` + vitest (fmagentes).

**Spec:** `docs/superpowers/specs/2026-10-23-crm-fiuza-marine-design.md` (fmagentes). Leia junto com este plano.

## Global Constraints

- CRM: repositório `C:\Users\Dell\Desktop\aula`, branch nova `feat/fiuza-marine-crm` a partir de `main` (`3a5623c`). Não tocar nos `.png` soltos nem em `.claude/settings.local.json` (sujeira local pré-existente).
- fmagentes: branch nova `feat/crm-fiuza-marine-agent` a partir de `master`.
- Supabase do CRM: projeto `nzeghgeytskpaqplgngj`. SQL roda pela ferramenta MCP `execute_sql` / `apply_migration` do plugin Supabase (autenticar com `mcp__plugin_supabase_supabase__authenticate` se preciso). Se o MCP não estiver disponível, parar e pedir ao dono para colar no SQL Editor.
- **Até a Task 9 nada é aplicado de verdade no banco.** Testes SQL rodam em "dry-run": um único `execute_sql` com `begin;` + conteúdo da(s) migração(ões) + conteúdo do teste + `rollback;`. O banco é de produção.
- Migrações novas: `011_`, `012_`, `013_`, no padrão das existentes: RLS, GRANT por coluna, RPC `SECURITY DEFINER SET search_path = pg_catalog, public`, `REVOKE EXECUTE ... FROM PUBLIC, anon`, comentário no topo explicando o porquê.
- `phone_digits` e `search_vector` são colunas geradas: nunca entram em INSERT/UPDATE.
- CRM não tem framework de testes de UI e **não** se introduz um (decisão do plano de 2026-07-12). Verificação de telas: `npx tsc --noEmit`, `npm run lint`, `npm run build` e roteiro manual na Task 9.
- fmagentes: TDD com vitest. `pnpm --filter @fmagentes/agent test`, `pnpm --filter @fmagentes/messaging test`, `pnpm --filter <pkg> build` (= `tsc --noEmit`).
- Identidade visual "dark náutico" do CRM mantida: usar só os componentes de `components/ui` e os tokens CSS existentes.
- IDs gravados no banco (em inglês/snake_case, minúsculos) e rótulos exibidos (pt-BR) — exatamente os da tabela "Catálogo" abaixo, iguais nos dois repositórios.
- A IA nunca move card, nunca grava `consortium_value`, `contract_number` nem `olist_*`, nunca sobrescreve campo preenchido.
- Commits: CRM em pt-BR (`feat(funis): ...`), fmagentes em inglês (`feat(agent): ...`), ambos terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Catálogo (fonte única de IDs e rótulos)

| Grupo | id → rótulo |
|---|---|
| Funis | `vendas` Vendas · `consorcios` Consórcios · `pecas` Peças e Acessórios · `manutencao` Serviços de Manutenção |
| Etapas vendas | `lead` Lead · `visita` Visita · `proposta` Proposta · `negociacao` Negociação · `fechado` Fechado |
| Etapas consorcios | `lead` Lead · `documentacao` Documentação · `contrato_assinado` Contrato Assinado · `contemplado` Contemplado · `encerrado` Encerrado |
| Etapas pecas | `lead` Lead · `orcamento` Orçamento · `pedido_confirmado` Pedido Confirmado · `entregue` Entregue |
| Etapas manutencao | `orcamento_solicitado` Orçamento Solicitado · `aprovado` Aprovado · `em_execucao` Em Execução · `entregue` Entregue · `pago` Pago |
| Origem do lead | `instagram` Instagram · `facebook` Facebook · `indicacao` Indicação · `google_meu_negocio` Google Meu Negócio · `site` Site Fiuza Marine · `lpage_motores` Lpage Motores · `lpage_servicos` Lpage Serviços · `outros` Outros |
| Tipo de produto / embarcação | `barco_lancha` Barco/Lancha · `jet_ski` Jet Ski · `motor_popa` Motor de Popa |
| Casco | `aluminio_mono` Alumínio mono casco · `fibra_mono` Fibra mono casco · `catamara` Catamarã · `outro` Outro |
| Qtde. motores | `unico` Único · `parelha` Parelha · `trelha` Trelha |
| Tipo de motor | `popa` Motor de popa · `centro` Motor de centro |
| Marcas motor de popa | `yamaha` Yamaha · `evinrude` Evinrude · `johnson` Johnson · `mercury` Mercury · `suzuki` Suzuki · `hidea` Hidea · `tohatsu` Tohatsu · `honda` Honda |
| Marcas jet ski | `sea_doo` Sea-Doo · `yamaha` Yamaha · `kawasaki` Kawasaki · `honda` Honda |

Campos do negócio (coluna → rótulo; funis onde existe; obrigatório a partir de):

| coluna | rótulo | tipo | funis | obrigatório a partir de |
|---|---|---|---|---|
| `product_type` | Tipo de produto | seleção (tipo de produto) | vendas | vendas/proposta |
| `brand` | Marca | texto | vendas | vendas/proposta |
| `model` | Modelo | texto | vendas | vendas/proposta |
| `year` | Ano | inteiro | vendas | vendas/proposta |
| `olist_proposal_number` | Nº da proposta (Olist) | texto | vendas, pecas, manutencao | vendas/proposta, pecas/orcamento |
| `olist_sales_order_number` | Nº do pedido de venda (Olist) | texto | vendas, pecas | pecas/pedido_confirmado |
| `consortium_value` | Valor do consórcio | moeda | consorcios | consorcios/contrato_assinado |
| `administrator` | Administradora | texto | consorcios | — |
| `contract_number` | Número do contrato | texto | consorcios | consorcios/contrato_assinado |
| `part_description` | Descrição da peça | texto | pecas | pecas/orcamento |
| `vessel_id` | Embarcação/motor | referência a `vessels` | manutencao | manutencao/aprovado |
| `service_description` | Descrição do serviço | texto | manutencao | manutencao/aprovado |
| `olist_service_order_number` | Nº da OS (Olist) | texto | manutencao | manutencao/aprovado |

Campos de embarcação por tipo (coluna → rótulo):
- `barco_lancha`: `hull_type` Tipo de casco · `builder` Estaleiro/marca · `length_m` Tamanho (m) · `length_ft` Tamanho (pés) · `boat_year` Ano do barco · `engine_count` Quantidade de motores · `engine_type` Tipo de motor · `engine_brand` Marca do motor · `horsepower` Potência (HP) · `engine_year` Ano do motor
- `motor_popa`: `brand` Marca (lista motor de popa) · `horsepower` Potência (HP) · `model` Modelo/série · `year` Ano de fabricação
- `jet_ski`: `brand` Marca (lista jet ski) · `model` Modelo · `year` Ano de fabricação
- todos: `notes` Observações

Campos novos do cliente: `landline` Telefone fixo · `birthday` Aniversário · `lead_source` Origem do lead · `referred_by` Quem indicou. `phone` passa a ser exibido como "WhatsApp"; `cpf` (nome da coluna mantido) guarda CPF **ou** CNPJ e é exibido como "CPF/CNPJ".

### Decisões do construtor (tomadas neste plano)

1. **Marca do motor de Barco/Lancha** ganha campo próprio `engine_brand`, em texto livre (motor de centro tem marcas fora da lista do dono).
2. **Registros criados pela IA num vínculo não verificado** (CPF digitado) levam `created_by_conversation` = id da conversa do fmagentes. Nesse vínculo, a IA só lê e completa o que ela mesma criou **nesta conversa**. Sem isso, cada mensagem abriria um negócio novo.
3. A coluna `cpf` não é renomeada: o agente atual e o dashboard continuam funcionando durante a troca.
4. A equipe pode criar negócio em qualquer coluna, mas `create_deal` aplica a mesma trava da etapa escolhida (senão o "+" da coluna Proposta furaria a regra).
5. Mudar o cliente de um negócio de manutenção com embarcação de outro cliente é recusado pelo banco (FK composta); a tela limpa a embarcação ao trocar de cliente.

## Review Focus

1. **Negócio antigo avançado depois da migração** (estava em `contato`, agora `visita`, arrastado para Proposta sem tipo/marca/modelo/ano/nº proposta) → o banco recusa com `missing_required_fields` e a tela abre o formulário com exatamente esses 5 campos. Teste: Task 3 (`013_pipelines.test.sql`, bloco "legado").
2. **Vínculo por CPF digitado tentando completar embarcação/negócio de outra conversa ou da equipe** → recusado sem revelar nada. Teste: Task 13 (`fillVessel`/`fillDeal` fora do escopo lançam `CrmNotInScopeError`) e Task 14 (ferramenta devolve erro neutro).
3. **Cliente informa valor diferente do já salvo** (outro e-mail, outro ano) → nada é sobrescrito, uma linha "Cliente informou … diferente: …" vai para observações, sem repetir em retentativa. Teste: Task 12 (`planFill`) e Task 13 (adapter).
4. **Equipe edita o registro enquanto a IA completa** → o UPDATE da IA é guardado por `updated_at`; com 0 linhas afetadas relê e recalcula; não apaga a edição humana. Teste: Task 13 ("retries when updated_at changed").
5. **Origem mudada de Indicação para outra com "quem indicou" preenchido** → o banco recusa (`referred_by` só com `indicacao`) e a tela limpa o campo ao trocar a origem. Teste: Task 1 (`011_clients.test.sql`, bloco "referred_by").

---

# Parte A — CRM (`C:\Users\Dell\Desktop\aula`)

### Task 1: Migração 011 — ficha do cliente e visibilidade compartilhada de clientes

**Files:**
- Create: `supabase/migrations/011_clients_fiuza_fields.sql`
- Create: `supabase/tests/011_clients.test.sql`
- Create: `supabase/tests/README.md` (como rodar o dry-run; 10 linhas)

**Interfaces:**
- Produces: colunas `clients.landline text`, `clients.birthday date`, `clients.lead_source text`, `clients.referred_by text`; CHECK `clients_cpf_digits` passa a `cpf ~ '^([0-9]{11}|[0-9]{14})$'`; policies de `clients` liberadas para qualquer `authenticated`.

- [ ] **Step 1: Criar a branch** `git switch -c feat/fiuza-marine-crm` em `C:\Users\Dell\Desktop\aula`.

- [ ] **Step 2: Escrever o teste** `supabase/tests/011_clients.test.sql`. Cabeçalho comum a todos os testes SQL (copiar nos três):

```sql
-- Roda dentro de begin/rollback (ver supabase/tests/README.md). Nunca commitar.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@test.local', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'b@test.local', 'authenticated', 'authenticated');
-- login como A: set local role authenticated; select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
-- voltar a postgres: reset role;
```

Blocos (cada um um `do $$ ... $$` com `assert` ou o padrão "espera erro": chamar, `raise exception 'expected <x>'`, `exception when others then assert sqlerrm like '%<x>%', sqlerrm;`):
- "visibilidade": como A, insere cliente `Cliente A`; como B, `select count(*) from clients where name = 'Cliente A'` = 1 e `update ... set notes = 'b' ... returning id` devolve 1 linha; `delete` também.
- "cnpj": insere com `cpf = '11222333000181'` (14 dígitos) ok; `cpf = '123'` falha com `clients_cpf_digits`.
- "lead_source": `lead_source = 'whatsapp'` falha com `clients_lead_source_check`; `'indicacao'` ok.
- "referred_by": `lead_source = 'instagram', referred_by = 'Zé'` falha com `clients_referred_by_needs_indicacao`; `lead_source = 'indicacao', referred_by = 'Zé'` ok; depois `update set lead_source = 'site'` falha com o mesmo nome.
- "anon": `set local role anon; select count(*) from clients` lança `permission denied`.

- [ ] **Step 3: Rodar o teste sozinho (dry-run sem a migração)** — `execute_sql` com `begin;` + teste + `rollback;`. Esperado: FAIL no bloco "visibilidade" (B vê 0 linhas) ou em coluna `lead_source` inexistente.

- [ ] **Step 4: Escrever `011_clients_fiuza_fields.sql`**: `ALTER TABLE clients ADD COLUMN` dos 4 campos; CHECK `clients_lead_source_check` com os 8 ids do catálogo; CHECK `clients_referred_by_needs_indicacao` = `referred_by IS NULL OR lead_source = 'indicacao'`; troca `clients_cpf_digits` (drop + add) para 11 **ou** 14 dígitos (comentário: dígitos verificadores são validados na aplicação e no agente); `DROP POLICY` das 4 policies de `clients` e recria `TO authenticated USING (true) WITH CHECK (true)`, mantendo `user_id NOT NULL` como "quem criou". GRANTs da tabela continuam (já cobrem colunas novas).

- [ ] **Step 5: Dry-run migração + teste.** Esperado: termina sem erro (todas as asserções passaram) e o `rollback` desfaz tudo.

- [ ] **Step 6: Commit** `feat(clientes): ficha Fiuza Marine (CNPJ, fixo, aniversario, origem) e clientes compartilhados`.

### Task 2: Migração 012 — embarcações do cliente

**Files:**
- Create: `supabase/migrations/012_vessels.sql`
- Create: `supabase/tests/012_vessels.test.sql`

**Interfaces:**
- Consumes: Task 1 (cliente compartilhado).
- Produces: tabela `public.vessels` (`id uuid pk`, `user_id uuid not null → auth.users`, `client_id uuid not null → clients on delete cascade`, `kind text not null`, colunas da tabela "Campos de embarcação", `notes text`, `created_by_conversation uuid`, `created_at`, `updated_at`), `UNIQUE (id, client_id)` (alvo da FK composta da Task 3), trigger `vessels_sync_length`.

- [ ] **Step 1: Escrever o teste** com o cabeçalho comum e um cliente fixo. Blocos:
- "metros→pés": insert `barco_lancha` com `length_m = 6` → `length_ft = 19.7`; update `length_ft = 30` → `length_m = 9.1`; insert com os dois (`6`, `50`) → `length_ft = 19.7` (metros vence).
- "campos por tipo": `jet_ski` com `hull_type = 'fibra_mono'` falha com `vessels_fields_match_kind`; `motor_popa` com `brand = 'sea_doo'` falha com `vessels_brand_matches_kind`; `jet_ski` com `brand = 'sea_doo'` ok; `barco_lancha` com `engine_brand = 'Volvo Penta'` ok.
- "faixas": `year = 1800` falha (`vessels_years_range`, 1900–2100); `horsepower = 0` falha (`vessels_positive_numbers`).
- "mínimo": insert só com `client_id`, `user_id`, `kind` ok (nada obrigatório).
- "visibilidade": criado por A, B lê/edita/exclui; `anon` sem acesso.
- "cascade": apagar o cliente apaga as embarcações.

- [ ] **Step 2: Dry-run do teste sem a migração** (só Task 1 + teste). Esperado: FAIL `relation "public.vessels" does not exist`.

- [ ] **Step 3: Escrever `012_vessels.sql`.** CHECKs: `kind IN (barco_lancha, motor_popa, jet_ski)`; enums do catálogo para `hull_type`, `engine_count`, `engine_type`; `vessels_fields_match_kind`: colunas exclusivas de barco (`hull_type, builder, length_m, length_ft, boat_year, engine_count, engine_type, engine_brand, engine_year`) só com `kind = 'barco_lancha'`; `brand, model, year` só com `kind <> 'barco_lancha'`; `horsepower` só com `kind <> 'jet_ski'`. `vessels_brand_matches_kind`: `brand` na lista de motor de popa quando `motor_popa`, na lista de jet ski quando `jet_ski`. `vessels_years_range` para `boat_year, engine_year, year`; `vessels_positive_numbers` para `length_m, length_ft, horsepower`. Trigger `BEFORE INSERT OR UPDATE` `public.vessels_sync_length()`: no INSERT, se `length_m` não nulo calcula `length_ft = round(length_m / 0.3048, 1)`, senão se `length_ft` não nulo calcula `length_m = round(length_ft * 0.3048, 1)`; no UPDATE, recalcula o lado que **não** mudou a partir do que mudou (`IS DISTINCT FROM OLD`); se os dois mudaram, metros vence. Trigger `vessels_updated_at` com `set_updated_at()`. Índice `idx_vessels_client_id`. RLS `TO authenticated USING (true) WITH CHECK (true)` para select/insert/update/delete; `REVOKE ALL ... FROM PUBLIC, anon`; `GRANT SELECT, INSERT, UPDATE, DELETE TO authenticated`.

- [ ] **Step 4: Dry-run 011 + 012 + teste.** Esperado: sem erro.

- [ ] **Step 5: Commit** `feat(embarcacoes): tabela de embarcacoes e motores do cliente`.

### Task 3: Migração 013 — 4 funis, campos do negócio, trava de etapa e RPC do agente

**Files:**
- Create: `supabase/migrations/013_pipelines.sql`
- Create: `supabase/tests/013_pipelines.test.sql`

**Interfaces:**
- Consumes: `vessels (id, client_id)` da Task 2.
- Produces (usado pelas Tasks 7, 8 e 13):
  - `deals.pipeline text not null` (FK `(pipeline, stage) → pipeline_stages`), as colunas da tabela "Campos do negócio", `deals.notes text`, `deals.created_by_conversation uuid`. `deals.value` permanece no banco e deixa de ser usado.
  - `create_deal(p_client_id uuid, p_pipeline text, p_stage text, p_title text, p_fields jsonb DEFAULT '{}') RETURNS uuid`
  - `move_deal_to_stage(p_deal_id uuid, p_new_stage text, p_new_position integer DEFAULT NULL) RETURNS void` (mesma assinatura de hoje)
  - `reorder_deals(ordered_ids uuid[], p_pipeline text, p_stage text) RETURNS integer`
  - `agent_create_deal(p_user_id uuid, p_client_id uuid, p_pipeline text, p_title text, p_fields jsonb, p_conversation_id uuid) RETURNS uuid` — só `service_role`.
  - Erro da trava: `RAISE EXCEPTION 'missing_required_fields' USING DETAIL = '<col1>,<col2>,...'` (ordem da coluna `position` de `deal_required_fields`). No supabase-js chega como `error.message === 'missing_required_fields'` e `error.details`.

- [ ] **Step 1: Escrever o teste** com o cabeçalho comum, cliente C1 (de A) com embarcação V1 e cliente C2 com embarcação V2. Blocos:
- "catálogo": `select count(*) from pipeline_stages` = 19; etapas de `manutencao` em ordem = `{orcamento_solicitado,aprovado,em_execucao,entregue,pago}`.
- "legado": um deal no formato antigo (`stage = 'contato'`, `value = 500`) é inserido como postgres **antes** da 013 no dry-run (ordem na Step 4); depois da migração: `pipeline = 'vendas'`, `stage = 'visita'`, `value = 500`. Como A, `move_deal_to_stage(<legado>, 'proposta')` falha com `missing_required_fields` e `DETAIL = 'product_type,brand,model,year,olist_proposal_number'` (usar `get stacked diagnostics d = pg_exception_detail`).
- "trava passa": preencher os 5 campos via `update` como A e mover para `proposta` ok; mover de volta para `lead` ok; mover para `negociacao` ok.
- "outras trilhas": em `pecas`, mover para `orcamento` sem nada → `DETAIL = 'part_description,olist_proposal_number'`; para `pedido_confirmado` com os dois preenchidos → `DETAIL = 'olist_sales_order_number'`. Em `manutencao` para `aprovado` → `'vessel_id,service_description,olist_service_order_number'`. Em `consorcios` para `contemplado` → `'consortium_value,contract_number'`. Texto só com espaços conta como vazio.
- "etapa inválida": `move_deal_to_stage(<deal vendas>, 'aprovado')` falha com `invalid stage`.
- "create_deal": `create_deal(C1, 'vendas', 'proposta', 'X', '{}')` falha com `missing_required_fields`; com os 5 campos em `p_fields` ok e as colunas gravadas; `create_deal(C1, 'vendas', 'lead', 'X', '{"service_description":"y"}')` falha com `deals_fields_match_pipeline`.
- "compartilhado": deal criado por A; como B, `move_deal_to_stage` e `reorder_deals(array[...], 'vendas', 'lead')` funcionam e `select` vê o deal.
- "embarcação de outro cliente": `update deals set vessel_id = V2` num deal de manutenção de C1 falha com violação de FK (`deals_vessel_client_fkey`); apagar V1 deixa `vessel_id` nulo e mantém `client_id`.
- "colunas protegidas": como A, `update deals set stage = 'fechado'` e `set pipeline = 'pecas'` falham com `permission denied`.
- "agente": como A (authenticated), `agent_create_deal(...)` lança `permission denied for function`. Como `service_role` (`set local role service_role`): cria em `manutencao` na etapa `orcamento_solicitado` com `created_by_conversation` gravado; com `p_fields = '{"consortium_value":1}'` falha com `agent cannot set consortium_value` (idem `contract_number` e qualquer `olist_*`).
- "anon": `create_deal`, `move_deal_to_stage`, `reorder_deals` → `permission denied`.

- [ ] **Step 2: Dry-run do teste sem a 013.** Esperado: FAIL `relation "public.pipeline_stages" does not exist`.

- [ ] **Step 3: Escrever `013_pipelines.sql`** nesta ordem:
  1. `pipeline_stages(pipeline text, stage text, label text not null, position int not null, primary key (pipeline, stage))` com as 19 linhas do catálogo; `deal_required_fields(pipeline text, field text, from_stage text, position int, primary key (pipeline, field), foreign key (pipeline, from_stage) references pipeline_stages)` com as 11 linhas da tabela "Campos do negócio" (`position` = ordem da tabela dentro do funil). RLS ligada, `SELECT` para `authenticated`, nada mais.
  2. `ALTER TABLE deals`: `ADD pipeline text NOT NULL DEFAULT 'vendas'`; colunas de campos; `notes`; `created_by_conversation`. `UPDATE deals SET stage = 'visita' WHERE stage = 'contato'`. Drop do CHECK antigo de `stage`; `ALTER pipeline DROP DEFAULT`; FK `(pipeline, stage) REFERENCES pipeline_stages`. CHECK `deals_fields_match_pipeline` (cada coluna só nos funis da tabela), `deals_year_range` (1900–2100), `deals_consortium_value_nonneg`. FK composta `deals_vessel_client_fkey (vessel_id, client_id) REFERENCES vessels (id, client_id) ON DELETE SET NULL (vessel_id)` (Postgres ≥ 15 — conferir `show server_version` no dry-run). Índice `idx_deals_pipeline` passa a `(pipeline, stage, position)`; `idx_deals_vessel_id`.
  3. Função interna `public.deal_missing_fields(p_deal public.deals, p_stage text) RETURNS text[]` (não exposta: `REVOKE ... FROM PUBLIC, anon, authenticated`): campos de `deal_required_fields` do funil do deal cuja `from_stage` tem `position` ≤ a da etapa `p_stage`, e cujo valor `to_jsonb(p_deal) ->> field` é nulo ou `btrim` vazio, ordenados por `position`.
  4. Função interna `public.next_deal_position(p_pipeline text, p_stage text) RETURNS integer`: `pg_advisory_xact_lock(hashtextextended('deal-pos:' || p_pipeline || ':' || p_stage, 0))` + `COALESCE(MAX(position), -1) + 1` sem filtro de dono. Mesmo lock usado por `move_deal_to_stage` e `reorder_deals`.
  5. `DROP FUNCTION create_deal(uuid, text, numeric, text)` e `reorder_deals(uuid[], text)`; recriar os três RPCs com as assinaturas do Interfaces. `create_deal`: exige `auth.uid()`, etapa válida para o funil, título não vazio, cliente existente (qualquer dono); monta o registro com `jsonb_populate_record(null::public.deals, p_fields)` copiando **só** as colunas de campos; checa `deal_missing_fields` contra `p_stage` e lança o erro da trava; insere com `user_id = auth.uid()`. `move_deal_to_stage`: lê o deal (qualquer dono) `FOR UPDATE`, valida etapa no funil do deal, checa a trava contra a etapa de destino, pega o lock e atualiza. `reorder_deals`: valida etapa no funil, lock, atualiza só linhas daquele `(pipeline, stage)`.
  6. `agent_create_deal`: sem checagem de `auth.uid()`; rejeita chaves `consortium_value`, `contract_number`, `olist_proposal_number`, `olist_sales_order_number`, `olist_service_order_number` com `agent cannot set <chave>`; sempre na primeira etapa do funil (`min(position)`); título obrigatório; grava `created_by_conversation`. `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role`.
  7. Policies de `deals` recriadas `TO authenticated USING (true)`, `deals_update` mantendo `WITH CHECK (EXISTS cliente)`. `REVOKE UPDATE ON deals FROM authenticated; GRANT UPDATE (title, client_id, notes, product_type, brand, model, year, olist_proposal_number, olist_sales_order_number, olist_service_order_number, consortium_value, administrator, contract_number, part_description, vessel_id, service_description, updated_at) ON deals TO authenticated`. Grants de EXECUTE dos três RPCs para `authenticated`, revogados de `PUBLIC, anon`.
  8. `NOTIFY pgrst, 'reload schema';` no fim.

- [ ] **Step 4: Ajustar a ordem do dry-run** para cobrir dados legados: `begin;` + 011 + 012 + cabeçalho e inserts de fixture **do formato antigo** (deal `contato` com `value 500`) + 013 + resto do teste + `rollback;`. Documentar essa ordem no `supabase/tests/README.md`.

- [ ] **Step 5: Rodar o dry-run.** Esperado: sem erro.

- [ ] **Step 6: Commit** `feat(funis): 4 funis da Fiuza Marine com campos, trava de etapa e RPC do agente`.

### Task 4: Catálogo TS e CPF/CNPJ no CRM

**Files:**
- Create: `lib/catalog.ts`
- Modify: `lib/cpf.ts` (renomear para `lib/document.ts`)
- Delete: `lib/constants.ts`

**Interfaces:**
- Produces:
  - `PIPELINES: readonly { id: PipelineId; label: string; stages: readonly { id: string; label: string }[] }[]`, `type PipelineId`, `pipelineById(id: PipelineId)`, `isPipelineId(v: string): v is PipelineId`.
  - `DEAL_FIELDS: Record<DealFieldId, { label: string; input: 'text' | 'integer' | 'money' | 'select' | 'vessel'; options?: readonly Option[]; pipelines: readonly PipelineId[] }>` e `dealFieldsFor(pipeline: PipelineId): DealFieldId[]` (ordem da tabela), `requiredFields(pipeline: PipelineId, stage: string): DealFieldId[]` (mesma regra e ordem do SQL).
  - `LEAD_SOURCES`, `VESSEL_KINDS`, `HULL_TYPES`, `ENGINE_COUNTS`, `ENGINE_TYPES`, `OUTBOARD_BRANDS`, `JET_SKI_BRANDS` como `readonly Option[]` (`type Option = { id: string; label: string }`), `VESSEL_FIELDS: Record<VesselKind, readonly VesselFieldId[]>`, `labelOf(options, id)`.
  - `lib/document.ts`: `normalizeDocument`, `isValidCpf`, `isValidCnpj`, `isValidCpfOrCnpj`, `formatCpfCnpj` (máscara `000.000.000-00` até 11 dígitos, `00.000.000/0000-00` com mais).
- Valores: exatamente o Catálogo deste plano.

- [ ] **Step 1: Escrever `lib/catalog.ts` e `lib/document.ts`** (CNPJ: 14 dígitos, não todos iguais, pesos `5,4,3,2,9,8,7,6,5,4,3,2` e `6,5,4,3,2,9,8,7,6,5,4,3,2`, resto < 2 → 0 senão 11 − resto). Atualizar imports de `@/lib/cpf` e `@/lib/constants`.
- [ ] **Step 2: Verificar** `npx tsc --noEmit`. Esperado: erros só nos usos de `PIPELINE_STAGES`/`Stage` em `PipelineBoard.tsx` (resolvidos na Task 7). Para manter a task verde, trocar esses usos por `pipelineById('vendas').stages` temporariamente; depois `npx tsc --noEmit` e `npm run lint` sem erros.
- [ ] **Step 3: Commit** `feat(crm): catalogo da Fiuza Marine e validacao de CNPJ`.

### Task 5: Tela de clientes — ficha nova e dados compartilhados

**Files:**
- Modify: `app/dashboard/clientes/page.tsx`, `app/dashboard/clientes/ClientsTable.tsx`

**Interfaces:**
- Consumes: `LEAD_SOURCES`, `isValidCpfOrCnpj`, `formatCpfCnpj`, `normalizeDocument` (Task 4); colunas da Task 1.

- [ ] **Step 1: `page.tsx`** — remover `.eq('user_id', user.id)`; selecionar também `landline, birthday, lead_source, referred_by`.
- [ ] **Step 2: `ClientsTable.tsx`** — schema zod: `cpf` aceita CPF **ou** CNPJ (`'CPF/CNPJ inválido'`), `landline` opcional, `birthday` `''` ou `YYYY-MM-DD`, `lead_source` `''` ou id de `LEAD_SOURCES`, `referred_by` opcional. Formulário: rótulos "WhatsApp" (para `phone`), "CPF/CNPJ", "Telefone fixo", "Aniversário" (`type="date"`), "Origem do lead" (select nativo estilizado como `Input`), "Quem indicou" só visível com `indicacao` e zerado ao trocar a origem (`setValue('referred_by', '')`). Payload: vazio → `null`; `referred_by` vira `null` se origem ≠ `indicacao`. **Update não envia `user_id`** (só o insert), senão editar o cliente de um colega trocaria "quem criou". Busca local inclui telefone fixo. Tabela ganha coluna "Origem" (rótulo). Mensagem do 23505: `'CPF/CNPJ já cadastrado em outro cliente'`.
- [ ] **Step 3: Verificar** `npx tsc --noEmit` e `npm run lint`. Esperado: sem erros.
- [ ] **Step 4: Commit** `feat(clientes): ficha com CPF/CNPJ, telefone fixo, aniversario e origem do lead`.

### Task 6: Embarcações na ficha do cliente

**Files:**
- Create: `app/dashboard/clientes/VesselsDialog.tsx`, `app/dashboard/clientes/VesselForm.tsx`
- Modify: `app/dashboard/clientes/ClientsTable.tsx` (botão "Embarcações" por linha, ícone `Ship` do lucide)

**Interfaces:**
- Consumes: `VESSEL_KINDS`, `VESSEL_FIELDS`, enums e `labelOf` (Task 4); tabela `vessels` (Task 2).
- Produces: `VesselsDialog({ client: { id: string; name: string } | null; userId: string; onClose(): void })`; `VesselForm({ initial?: Vessel; onSubmit(values: VesselInput): Promise<void>; onCancel(): void })`; `export type Vessel` (linha completa) e `export function describeVessel(v: Vessel): string` (ex.: `"Barco/Lancha · Fibra mono casco · 2018 · 2×150 HP"`, `"Motor de Popa · Mercury 150 HP · 2015"`, `"Jet Ski · Sea-Doo GTI · 2020"`), usada também na Task 7.

- [ ] **Step 1: `VesselForm.tsx`** — select de tipo; só os campos de `VESSEL_FIELDS[kind]` aparecem; trocar o tipo zera os campos que o novo tipo não tem (o CHECK do banco recusaria). Números: `z.coerce.number().positive()` ou vazio; anos 1900–2100 inteiros. Metros **ou** pés: os dois aparecem, com a dica "preencha um; o outro é calculado" e, ao salvar, só o campo editado vai no payload (o trigger calcula o outro).
- [ ] **Step 2: `VesselsDialog.tsx`** — ao abrir, `select('*').eq('client_id', id).order('created_at')`; lista com `describeVessel`, botões editar/excluir; excluir pede confirmação num `Dialog` (nunca `window.confirm`). Insert com `user_id: userId`; update sem `user_id`. Toasts no padrão da tela.
- [ ] **Step 3: Verificar** `npx tsc --noEmit` e `npm run lint`. Esperado: sem erros.
- [ ] **Step 4: Commit** `feat(embarcacoes): cadastro de embarcacoes e motores na ficha do cliente`.

### Task 7: Quadro com 4 funis e campos do negócio

**Files:**
- Modify: `app/dashboard/pipeline/page.tsx`, `app/dashboard/pipeline/PipelineBoard.tsx`
- Create: `app/dashboard/pipeline/PipelineTabs.tsx`, `app/dashboard/pipeline/DealFields.tsx`

**Interfaces:**
- Consumes: `PIPELINES`, `DEAL_FIELDS`, `dealFieldsFor`, `requiredFields` (Task 4); `describeVessel` (Task 6); RPCs da Task 3.
- Produces: `type Deal = { id; title; pipeline: PipelineId; stage: string; position: number; client_id: string; notes: string | null; clients: { name: string } | null } & Partial<Record<DealFieldId, string | number | null>>`; `DealFields({ pipeline: PipelineId; clientId: string; only?: DealFieldId[]; required: DealFieldId[]; register; control; setValue })` — usado pela Task 8.

- [ ] **Step 1: `page.tsx`** — lê `searchParams.funil` (padrão `vendas`; valor inválido → `vendas`); consulta deals `.eq('pipeline', funil)` sem filtro de dono, selecionando colunas de campos + `notes`; clientes sem filtro de dono. Passa `pipeline` ao board.
- [ ] **Step 2: `PipelineTabs.tsx`** — 4 links `?funil=<id>` no topo do quadro, ativo destacado com os tokens do `DashboardNav`.
- [ ] **Step 3: `DealFields.tsx`** — renderiza `dealFieldsFor(pipeline)` (ou `only`), marcando com `*` os `required`. `select` usa `options`; `money` formata BRL no blur; `vessel` carrega `vessels` do `clientId` (refaz ao trocar cliente, mostra `describeVessel`, opção vazia "—"), e o pai zera `vessel_id` quando o cliente muda.
- [ ] **Step 4: `PipelineBoard.tsx`** — colunas = `pipelineById(pipeline).stages`; cor da barra por índice da etapa (`var(--chart-1..5)`); remover valor/`fmt` dos cards e formulários; card mostra título + nome do cliente. Criar: `create_deal({ p_client_id, p_pipeline, p_stage, p_title, p_fields })`, com zod exigindo `requiredFields(pipeline, stage)`. Editar: `update` de `title`, `client_id`, `notes` e dos campos do funil (vazio → `null`). `reorder_deals` recebe `p_pipeline`. Erro 23503 ao salvar → toast `'A embarcação escolhida é de outro cliente'`.
- [ ] **Step 5: Verificar** `npx tsc --noEmit` e `npm run lint`. Esperado: sem erros.
- [ ] **Step 6: Commit** `feat(funis): quadro com os 4 funis e campos por funil`.

### Task 8: Trava ao mover card — completar e mover

**Files:**
- Create: `app/dashboard/pipeline/MissingFieldsDialog.tsx`
- Modify: `app/dashboard/pipeline/PipelineBoard.tsx` (ramo cross-stage do `onDragEnd`)

**Interfaces:**
- Consumes: `DealFields` com `only` (Task 7); erro `missing_required_fields` + `details` (Task 3).
- Produces: `MissingFieldsDialog({ deal: Deal; targetStage: string; fields: DealFieldId[]; onDone(saved: boolean): void })`.

- [ ] **Step 1: No `onDragEnd`**, quando `move_deal_to_stage` volta com `error.message === 'missing_required_fields'`: rollback otimista (já existe), **sem** toast de erro; abrir o diálogo com `fields = error.details.split(',')`, `targetStage` e o `destIndex` guardado.
- [ ] **Step 2: `MissingFieldsDialog`** — título `Para mover para <rótulo da etapa>, preencha:`; só os campos faltantes, todos obrigatórios. Salvar: `update` dos campos; depois `move_deal_to_stage` com a mesma posição; se o banco ainda devolver `missing_required_fields` (outro usuário apagou algo nesse meio-tempo), atualizar a lista e manter aberto; sucesso → toast `Negócio movido`, fechar e `router.refresh()`. Cancelar não move nada.
- [ ] **Step 3: Verificar** `npx tsc --noEmit`, `npm run lint`, `npm run build`. Esperado: sem erros.
- [ ] **Step 4: Commit** `feat(funis): formulario de campos obrigatorios ao mover card`.

### Task 9: Virada no banco de produção e roteiro manual

**Files:** nenhum novo (só aplica).

- [ ] **Step 1: Confirmar com o dono** o horário (o CRM em produção quebra entre aplicar a 013 e publicar o app novo, porque `create_deal`/`reorder_deals` mudam de assinatura). Não seguir sem o "ok".
- [ ] **Step 2: Backup**: `create table backup_20261102_deals as select * from public.deals; create table backup_20261102_clients as select * from public.clients;` (com RLS ligada e sem grants). Anotar `count(*)` de deals por `stage` e de clients.
- [ ] **Step 3: Aplicar 011, 012, 013** com `apply_migration` (nomes `011_clients_fiuza_fields`, `012_vessels`, `013_pipelines`).
- [ ] **Step 4: Conferir**: mesma contagem de clients; deals por etapa iguais às de antes com `contato` → `visita`; `get_advisors` (security) sem alertas novos.
- [ ] **Step 5: Publicar o app** (merge em `main`, push, redeploy no EasyPanel — perguntar ao dono como o CRM está publicado hoje se não estiver documentado no README).
- [ ] **Step 6: Roteiro manual no navegador** (dois usuários da equipe): cliente com CNPJ; origem Indicação com "quem indicou" e troca para Instagram limpa o campo; embarcação Barco/Lancha com 6 m mostra 19,7 pés; jet ski; criar negócio em Vendas/Lead; arrastar para Proposta abre o formulário com 5 campos, preencher move; negócio antigo aparece em Visita; Manutenção com embarcação do cliente; o outro usuário vê e move tudo; valor não aparece em lugar nenhum além de Consórcios.
- [ ] **Step 7:** depois de uma semana sem problema, perguntar ao dono antes de apagar as tabelas `backup_20261102_*`.

---

# Parte B — fmagentes (agente WhatsApp)

### Task 10: CNPJ no cadastro feito pela IA

**Files:**
- Create: `packages/agent/src/cnpj.ts`, `packages/agent/tests/cnpj.test.ts`
- Modify: `packages/agent/src/tools/registerCustomer.ts`, `packages/agent/tests/registerCustomer.test.ts`, `packages/agent/src/index.ts`

**Interfaces:**
- Produces: `isValidCnpj(input: string): boolean`, `isValidCpfOrCnpj(input: string): boolean` (exportados no `index.ts`). `RegistrationArgs` passa a `{ nome: string; cpf_cnpj: string; email: string }`; `NewCrmClient.cpf` continua o nome do campo (dígitos de CPF ou CNPJ).

- [ ] **Step 1: Criar a branch** `git switch -c feat/crm-fiuza-marine-agent` no fmagentes.
- [ ] **Step 2: Testes falhando** — `cnpj.test.ts`: `isValidCnpj('11.222.333/0001-81') === true`, `'11222333000181'` true, `'11.222.333/0001-82'` false, `'00000000000000'` false, `'1122233300018'` (13) false; `isValidCpfOrCnpj('529.982.247-25')` true. `registerCustomer.test.ts`: trocar `cpf` por `cpf_cnpj` nos args; novo caso "creates a client with a CNPJ" esperando `create` com `cpf: '11222333000181'`; caso inválido espera `/CPF ou CNPJ inválido/`.
- [ ] **Step 3: Rodar** `pnpm --filter @fmagentes/agent test`. Esperado: FAIL (módulo `cnpj` não existe).
- [ ] **Step 4: Implementar** `cnpj.ts` (mesmos pesos da Task 4) e ajustar `registerCustomer` (mensagem de erro `Erro: CPF ou CNPJ inválido. Peça ao cliente para conferir e enviar novamente.`; descrição da ferramenta: `"Cadastra o cliente no CRM. Chame somente quando tiver nome completo, CPF ou CNPJ e e-mail informados pelo cliente."`; parâmetro `cpf_cnpj` descrito como `"CPF ou CNPJ do cliente, com ou sem pontuação"`).
- [ ] **Step 5: Rodar** os testes do pacote. Esperado: PASS.
- [ ] **Step 6: Commit** `feat(agent): accept CNPJ when the agent registers a customer`.

### Task 11: `CustomerContext` com id do cliente e vínculo verificado

**Files:**
- Modify: `packages/messaging/src/responder.ts`, `packages/messaging/src/respondToInboundMessage.ts` (`identifyCustomer`), `packages/messaging/tests/respondToInboundMessage.test.ts`, e todos os usos de `{ status: "registered" ... }` em `packages/agent/tests/*` (achar com `grep -rn 'status: "registered"' packages apps`)

**Interfaces:**
- Produces: `type CustomerContext = { status: "registered"; crmClientId: string; verified: boolean; name?: string } | { status: "unregistered" }`. `verified` é `true` para vínculo por telefone ou criado pela IA, `false` para CPF/CNPJ digitado. `name` só quando `verified`.

- [ ] **Step 1: Testes falhando** — nos três testes existentes de `respondToInboundMessage.test.ts` (linhas ~357, ~373, ~386) as expectativas passam a `{ status: "registered", crmClientId: "<id do fixture>", verified: true, name: "Ana Souza" }` e, para o vínculo por CPF, `{ status: "registered", crmClientId: "<id>", verified: false }`.
- [ ] **Step 2: Rodar** `pnpm --filter @fmagentes/messaging test`. Esperado: FAIL nas 3 expectativas.
- [ ] **Step 3: Implementar** o tipo e `identifyCustomer`; ajustar os testes do pacote `agent` que montam `CustomerContext` (incluir `crmClientId: "crm-1", verified: true`; o caso "omits the name (CPF link)" usa `verified: false`).
- [ ] **Step 4: Rodar** `pnpm --filter @fmagentes/messaging test`, `pnpm --filter @fmagentes/agent test` e `pnpm build`. Esperado: PASS e sem erros de tipo.
- [ ] **Step 5: Commit** `feat(messaging): tell the responder which CRM client is linked and whether the link is verified`.

### Task 12: Catálogo do agente e "preencher só o vazio"

**Files:**
- Create: `packages/agent/src/crm/catalog.ts`, `packages/agent/src/crm/fill.ts`, `packages/agent/tests/fill.test.ts`, `packages/agent/tests/catalog.test.ts`

**Interfaces:**
- Produces:
  - `catalog.ts`: `PIPELINE_IDS` (tupla dos 4 ids), `type PipelineId`, `PIPELINE_LABELS`, `STAGES: Record<PipelineId, readonly { id: string; label: string }[]>`, `lastStage(p: PipelineId): string`, `LEAD_SOURCE_IDS`, `VESSEL_KIND_IDS`, `HULL_TYPE_IDS`, `ENGINE_COUNT_IDS`, `ENGINE_TYPE_IDS`, `OUTBOARD_BRAND_IDS`, `JET_SKI_BRAND_IDS` (tuplas `as const` para `z.enum`), `CLIENT_FIELD_LABELS`, `VESSEL_FIELD_LABELS`, `DEAL_FIELD_LABELS` (`Record<coluna, rótulo>`), `AGENT_DEAL_FIELDS: Record<PipelineId, readonly string[]>` = vendas `product_type, brand, model, year`; consorcios `administrator`; pecas `part_description`; manutencao `vessel_id, service_description`.
  - `fill.ts`: `planFill(current: Record<string, unknown>, incoming: Record<string, unknown>, labels: Record<string, string>, notes: string | null): { patch: Record<string, unknown>; filled: string[]; conflicts: string[] }`. Ignora `incoming` `undefined`/`null`/string vazia. Campo atual vazio (null ou string só com espaços) → entra em `patch` e `filled`. Campo igual (strings comparadas com `trim().toLowerCase()`, números por valor) → nada. Diferente → em `conflicts` e uma linha `Cliente informou <rótulo> diferente: <valor>` acrescentada a `patch.notes` (separador `\n`), a menos que a linha já esteja em `notes`. Valores de enum entram na nota pelo id.

- [ ] **Step 1: Testes falhando** — `fill.test.ts`:
  - `fills empty fields only`: current `{ email: null, landline: '' }`, incoming `{ email: 'a@b.com', landline: '1133334444' }` → `patch` com os dois, `filled` = `['email','landline']`, `conflicts` = `[]`.
  - `keeps a saved value and notes the difference`: current `{ email: 'x@y.com' }`, incoming `{ email: 'a@b.com' }`, notes `'VIP'` → `patch = { notes: 'VIP\nCliente informou E-mail diferente: a@b.com' }`, `conflicts = ['email']`.
  - `treats case and spaces as the same value`: `'Mercury '` vs `'mercury'` → `patch = {}`.
  - `does not repeat a note already there` (retentativa) → `patch = {}`.
  - `ignores blank incoming values` → `patch = {}`.
  - `compares numbers by value`: current `{ year: 2018 }`, incoming `{ year: 2018 }` → `{}`; incoming `{ year: 2019 }` → conflito `Ano`.
  - `catalog.test.ts`: `lastStage('manutencao') === 'pago'`; `STAGES.vendas.map(s => s.id)` igual a `['lead','visita','proposta','negociacao','fechado']`; `AGENT_DEAL_FIELDS` não contém `consortium_value`, `contract_number` nem nada que comece com `olist_`.
- [ ] **Step 2: Rodar** e ver FAIL (módulos inexistentes).
- [ ] **Step 3: Implementar** os dois arquivos com os valores do Catálogo.
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit** `feat(agent): CRM catalog and fill-only-empty planning`.

### Task 13: Adapter do CRM — retrato, ficha, embarcações e negócios

**Files:**
- Modify: `packages/agent/src/crm/CrmPort.ts`, `packages/agent/src/crm/supabaseCrm.ts`, `packages/agent/tests/supabaseCrm.test.ts`, `packages/agent/tests/support/fakeCrm.ts`, `packages/agent/tests/support/supabaseMock.ts` (adicionar `neq`, `in`, `order` ao chain e `rpc` ao cliente)
- Create: `packages/agent/src/crm/describe.ts`, `packages/agent/tests/describe.test.ts`

**Interfaces:**
- Consumes: `planFill`, catálogo (Task 12); `agent_create_deal` (Task 3); `CustomerContext` (Task 11).
- Produces (em `CrmPort.ts`):

```ts
export interface CrmScope { clientId: string; verified: boolean; conversationId: string }
export interface FillResult { filled: string[]; conflicts: string[] }
export interface CrmSnapshot {
  /** Only for a verified link; empty otherwise. */
  missingClientFields: ClientFieldId[];
  vessels: { id: string; kind: VesselKind; summary: string }[];
  openDeals: { id: string; pipeline: PipelineId; stageLabel: string; title: string }[];
}
export type ClientFieldId = "email" | "landline" | "birthday" | "lead_source" | "referred_by" | "company";
export type ClientFields = Partial<Record<ClientFieldId, string>>;
export type VesselFields = Partial<Record<VesselFieldId, string | number>>; // colunas da tabela de embarcações, sem notes
export type DealFields = Partial<Record<AgentDealFieldId, string | number>>;

// novos métodos de CrmPort
loadSnapshot(scope: CrmScope): Promise<CrmSnapshot>;
fillClient(scope: CrmScope, fields: ClientFields): Promise<FillResult>;            // exige scope.verified
createVessel(scope: CrmScope, kind: VesselKind, fields: VesselFields): Promise<{ id: string }>;
fillVessel(scope: CrmScope, vesselId: string, fields: VesselFields): Promise<FillResult & { kind: VesselKind }>;
findOpenDeal(scope: CrmScope, pipeline: PipelineId): Promise<{ id: string } | null>;
createDeal(scope: CrmScope, pipeline: PipelineId, title: string, fields: DealFields): Promise<{ id: string }>;
fillDeal(scope: CrmScope, dealId: string, fields: DealFields): Promise<FillResult>;

export class CrmNotInScopeError extends Error {} // name "CrmNotInScopeError"
```

- `describe.ts`: `describeVessel(row): string` com o mesmo formato da Task 6 (rótulos do catálogo).
- Escopo: registro está no escopo quando `client_id = scope.clientId` **e** (`scope.verified` **ou** `created_by_conversation = scope.conversationId`). Fora do escopo (ou inexistente) → `CrmNotInScopeError`, sem distinguir os dois casos. `fillClient` com `verified: false` → `CrmNotInScopeError`.
- Todos os `fill*`: `select` dos campos + `notes` + `updated_at`; `planFill`; se `patch` vazio, devolve sem escrever; senão `update(patch).eq('id', id).eq('updated_at', lido)` + `.select('id')`; 0 linhas → relê e recalcula, até `ATTACH_ATTEMPTS` (3) vezes; depois lança `Error('CRM <tabela> <id>: kept changing; not filled')`.
- `createVessel`: insert direto com `user_id = agentUserId` e `created_by_conversation = scope.conversationId` **só** quando `!scope.verified` (vínculo verificado grava `null`: o registro é do cliente).
- `createDeal` e `fillDeal` com `vessel_id` em `fields`: antes de escrever, conferem que a embarcação está no escopo pela mesma regra; senão `CrmNotInScopeError`.
- `createDeal`: `rpc('agent_create_deal', { p_user_id, p_client_id, p_pipeline, p_title, p_fields, p_conversation_id })` com `p_conversation_id` pela mesma regra.
- `findOpenDeal`: deals do cliente naquele funil no escopo, `stage <> lastStage(pipeline)`, mais recente por `updated_at`.
- `loadSnapshot`: verificado → lê o cliente (`ClientFieldId`s vazios em `missingClientFields`, menos `referred_by` quando `lead_source` ≠ `indicacao`), todas as embarcações do cliente e os negócios abertos; não verificado → `missingClientFields: []` e só embarcações/negócios com `created_by_conversation = conversationId`. Limite de 20 de cada.

- [ ] **Step 1: Testes falhando** em `supabaseCrm.test.ts` (novos `describe`):
  - `loadSnapshot` "verified: lists missing client fields, vessels and open deals" (deal em `fechado` fora da lista; `referred_by` fora quando origem não é indicação) e "unverified: reads only what this conversation created" (verifica `.eq('created_by_conversation', 'conv-1')` e nenhum `from('clients')`).
  - `fillClient` "writes only empty fields guarded by updated_at", "notes a different value instead of overwriting", "retries when updated_at changed" (primeiro update devolve `[]`, segundo `[{id}]`, 2 leituras), "gives up after 3 attempts", "refuses an unverified scope".
  - `fillVessel` / `fillDeal` "refuses a record outside the scope" para: outro cliente; vínculo não verificado + `created_by_conversation` de outra conversa; vínculo não verificado + `null` (registro da equipe). Mensagem do erro não contém dados do registro.
  - `createVessel` "stamps the conversation only on an unverified link"; `createDeal` "calls agent_create_deal with the agent user" (args exatos do RPC).
  - `findOpenDeal` "skips deals in the last stage".
  - `createDeal` "refuses a vessel_id outside the scope" (embarcação de outro cliente) sem chamar o RPC.
  - `describe.test.ts`: os três exemplos de `describeVessel` da Task 6.
- [ ] **Step 2: Rodar** e ver FAIL.
- [ ] **Step 3: Implementar** os métodos, `describe.ts`, extensões do mock e do `createFakeCrm` (novos métodos como `vi.fn` com retornos neutros: snapshot vazio, `{ id: 'vessel-new' }`, `{ id: 'deal-new' }`, `{ filled: [], conflicts: [] }`, `findOpenDeal → null`).
- [ ] **Step 4: Rodar** `pnpm --filter @fmagentes/agent test`. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(agent): CRM adapter reads a snapshot and fills client, vessels and deals`.

### Task 14: Ferramentas `atualizar_cliente`, `registrar_embarcacao`, `registrar_negocio`

**Files:**
- Create: `packages/agent/src/tools/updateCustomer.ts`, `packages/agent/src/tools/registerVessel.ts`, `packages/agent/src/tools/registerDeal.ts` e testes `packages/agent/tests/updateCustomer.test.ts`, `registerVessel.test.ts`, `registerDeal.test.ts`
- Modify: `packages/agent/src/index.ts` (exports)

**Interfaces:**
- Consumes: `CrmPort`, `CrmScope`, `CrmNotInScopeError` (Task 13); catálogo (Task 12).
- Produces: para cada ferramenta, uma função testável + a fábrica `tool()`:
  - `UPDATE_CUSTOMER_TOOL_NAME = "atualizar_cliente"`; `updateCustomer(crm, scope, args): Promise<string>`; `createUpdateCustomerTool(crm, scope)`. Parâmetros (todos opcionais): `email`, `telefone_fixo`, `aniversario` (`AAAA-MM-DD`), `origem` (`z.enum(LEAD_SOURCE_IDS)`), `quem_indicou`, `empresa`.
  - `REGISTER_VESSEL_TOOL_NAME = "registrar_embarcacao"`; `registerVessel(crm, scope, args)`; `createRegisterVesselTool(crm, scope)`. Parâmetros: `embarcacao_id?` (completar uma existente), `tipo` (`z.enum(VESSEL_KIND_IDS)`), e opcionais `tipo_casco`, `estaleiro`, `tamanho_metros`, `tamanho_pes`, `ano_barco`, `quantidade_motores`, `tipo_motor`, `marca_motor`, `potencia_hp`, `ano_motor`, `marca`, `modelo`, `ano` (enums do catálogo onde houver).
  - `REGISTER_DEAL_TOOL_NAME = "registrar_negocio"`; `registerDeal(crm, scope, args)`; `createRegisterDealTool(crm, scope)`. Parâmetros: `funil` (`z.enum(PIPELINE_IDS)`), `titulo` (descrito como `"Título curto do negócio, ex.: Revisão Mercury 150 HP, Compra jet ski"`), e opcionais `tipo_produto`, `marca`, `modelo`, `ano`, `administradora`, `descricao_peca`, `embarcacao_id`, `descricao_servico`. Não existe parâmetro de valor, contrato nem Olist.
- Respostas (texto exato que o modelo recebe):
  - sucesso: `"Salvo."`, mais `" Já havia outro valor salvo para: <rótulos>; a equipe vai conferir."` quando houver conflitos. `registrar_embarcacao` ao criar: `"Embarcação registrada (embarcacao_id: <id>)."`. `registrar_negocio`: `"Negócio aberto (negocio_id: <id>)."` ou, quando achou um aberto no funil, `"Negócio já aberto neste funil foi atualizado (negocio_id: <id>)."`.
  - fora do escopo / id inválido: `"Erro: registro não encontrado. Não cite este erro ao cliente; continue o atendimento."`.
  - tipo diferente ao completar embarcação: `"Erro: essa embarcação é de outro tipo. Registre uma nova."`.
  - `aniversario` inválido (não `AAAA-MM-DD` ou data impossível): campo descartado e resposta acrescenta `" Data de aniversário inválida, não foi salva."`.
  - `marca` fora da lista do tipo (motor de popa/jet ski) → não vai para `brand`; vai como `"Marca informada: <texto>"` em `notes` do item.
  - nada para gravar: `"Nada novo para salvar."`.
  - Campos de `registrar_negocio` que não pertencem ao funil (fora de `AGENT_DEAL_FIELDS[funil]`) são descartados.
  - Erro do CRM que não seja `CrmNotInScopeError` é relançado (o job tenta de novo).

- [ ] **Step 1: Testes falhando**, por ferramenta, contra `createFakeCrm`:
  - `updateCustomer`: mapeia `telefone_fixo`→`landline`, `origem`→`lead_source` e chama `fillClient(scope, { landline, lead_source })`; resposta com conflito cita o rótulo (`E-mail`); `aniversario: '2026-02-30'` descarta o campo e avisa.
  - `registerVessel`: cria com `kind` e campos mapeados (`tamanho_metros`→`length_m`, `potencia_hp`→`horsepower`) e responde com o id; com `embarcacao_id` chama `fillVessel`; `CrmNotInScopeError` vira o erro neutro; `kind` diferente vira o erro de tipo; `marca: 'Mercury'` com `tipo: 'jet_ski'` vai para `notes`.
  - `registerDeal`: sem negócio aberto chama `createDeal(scope, 'vendas', 'Compra jet ski', { product_type: 'jet_ski' })`; com `findOpenDeal → { id: 'deal-1' }` chama `fillDeal` e não `createDeal`; `descricao_servico` num funil `vendas` é descartado; `embarcacao_id` fora do escopo → erro neutro (vem de `fillDeal`/`createDeal` lançando `CrmNotInScopeError` — o adapter valida `vessel_id` pela mesma regra de escopo; adicionar esse caso ao teste do adapter da Task 13 se ainda não houver).
  - Para as três: a resposta nunca contém dados salvos do cliente (asserção com `not.toContain` para os valores do fixture).
- [ ] **Step 2: Rodar** e ver FAIL.
- [ ] **Step 3: Implementar** as três ferramentas. Descrições `tool({ description })`:
  - `atualizar_cliente`: `"Grava na ficha do cliente dados que ele mencionou. Só preenche campos vazios; nunca apaga o que já existe."`
  - `registrar_embarcacao`: `"Registra uma embarcação ou motor que o cliente JÁ TEM (não o que quer comprar). Use embarcacao_id para completar uma já registrada."`
  - `registrar_negocio`: `"Abre ou completa o negócio do cliente no funil do assunto. Nunca informe valores."`
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit** `feat(agent): tools to fill the customer record, vessels and deals`.

### Task 15: Prompt com o retrato do CRM e ferramentas por tipo de vínculo

**Files:**
- Modify: `packages/agent/src/buildPrompt.ts`, `packages/agent/src/LlmResponder.ts`, `packages/agent/tests/buildPrompt.test.ts`, `packages/agent/tests/LlmResponder.test.ts`

**Interfaces:**
- Consumes: `CrmSnapshot`, `loadSnapshot` (Task 13); fábricas de ferramentas (Task 14); `CustomerContext` (Task 11).
- Produces: `customerContextBlock(customer: CustomerContext, snapshot?: CrmSnapshot): string`; `buildPrompt(input & { snapshot?: CrmSnapshot })`; `MAX_STEPS = 6`.

- [ ] **Step 1: Testes falhando** — `buildPrompt.test.ts`:
  - Não cadastrado: `"Cliente SEM cadastro. Antes de prosseguir com o atendimento, peça nome completo, CPF ou CNPJ e e-mail e chame cadastrar_cliente."`
  - Verificado com retrato: bloco contém, nesta ordem e uma por linha, `Cliente cadastrado: Ana Souza. Trate o cliente pelo nome.`, `Campos da ficha ainda vazios: Telefone fixo, Aniversário, Origem do lead.`, `Origem do lead vazia: pergunte uma única vez nesta conversa, de forma leve, como o cliente conheceu a Fiuza Marine, e grave com atualizar_cliente.` (só quando `lead_source` está entre os vazios), `Embarcações do cliente:` seguido de `- <summary> (embarcacao_id: <id>)`, `Negócios abertos:` seguido de `- <Funil> · <etapa> · <título> (negocio_id: <id>)`. Seções vazias são omitidas.
  - Não verificado: `"Cliente identificado pelo CPF/CNPJ que digitou, sem confirmação. Não cite nenhum dado do cadastro. Você pode registrar embarcações e negócios novos; não atualize a ficha."` seguido só das listas do que esta conversa criou.
  - `PLATFORM_INSTRUCTIONS` contém as quatro linhas novas abaixo e o bloco cacheável continua idêntico entre clientes.
  - `LlmResponder.test.ts`: "offers handoff and registration to an unregistered customer"; "offers handoff, atualizar_cliente, registrar_embarcacao and registrar_negocio to a verified customer"; "offers no atualizar_cliente on an unverified link"; "loads the snapshot only for registered customers" (`crm.loadSnapshot` chamado com `{ clientId, verified, conversationId }`); "lets the model save twice and still reply" (modelo fake com 2 chamadas de ferramenta + texto em 3 passos → `reply`); o teste M10 usa `MAX_STEPS` (6).
- [ ] **Step 2: Rodar** e ver FAIL.
- [ ] **Step 3: Implementar.** Linhas novas em `PLATFORM_INSTRUCTIONS` (texto exato, depois das existentes):
  - `"- Quando o cliente mencionar algo que tem lugar no CRM (dados dele, embarcações ou motores que já tem, o que quer comprar, consórcio, peça, conserto), grave com a ferramenta certa, aos poucos, sem avisar nem pedir confirmação."`
  - `"- Pergunte só o que for necessário para o próximo passo do atendimento, uma coisa por vez. Se o cliente não souber ou não quiser responder, siga em frente. Nunca faça uma lista de perguntas."`
  - `"- Abra o negócio pelo assunto: compra de barco, lancha, jet ski ou motor → vendas; consórcio → consorcios; peça ou acessório → pecas; conserto, revisão ou manutenção → manutencao. Em manutenção, registre antes a embarcação ou motor e informe o embarcacao_id."`
  - `"- Nunca pergunte, sugira ou grave valores em dinheiro."`
  No `LlmResponder.generate`: cliente registrado → `scope = { clientId: customer.crmClientId, verified: customer.verified, conversationId: input.conversationId }`, `snapshot = await crm.loadSnapshot(scope)` (erro do CRM propaga: o job tenta de novo); ferramentas conforme os testes; `buildPrompt({ ...input, snapshot })`.
- [ ] **Step 4: Rodar** `pnpm --filter @fmagentes/agent test` e `pnpm build`. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(agent): show the CRM snapshot in the prompt and offer tools by link type`.

### Task 16: Verificação final e entrega

- [ ] **Step 1:** `pnpm test` e `pnpm build` na raiz do fmagentes. Esperado: tudo verde.
- [ ] **Step 2:** Revisão do branch inteiro (superpowers:requesting-code-review) nos dois repositórios.
- [ ] **Step 3: Teste real pelo WhatsApp** (depende da Task 9 aplicada e do agente rodando; o crédito da Anthropic está zerado segundo a memória — confirmar com o dono antes): número novo → cadastro com CNPJ; "tenho uma lancha de fibra de 2018 com dois Mercury 150" → embarcação criada com casco Fibra mono casco, ano do barco 2018, Parelha, Motor de popa, 150 HP, marca do motor Mercury; "quero revisar" → negócio em Manutenção/Orçamento Solicitado ligado à lancha; a IA pergunta a origem uma vez; nenhuma menção a valor; nenhum card movido.
- [ ] **Step 4:** superpowers:finishing-a-development-branch no fmagentes (o CRM já foi para `main` na Task 9).

> **Ordem de publicação (revisão 2026-11-07):** o agente deste branch só pode rodar **depois** da Task 9. Antes de 011–013 no banco, `loadSnapshot` lê `vessels` e `deals.pipeline`, que ainda não existem: todo turno de cliente cadastrado falharia, seria retentado e iria para humano; cadastro com CNPJ também falha no CHECK antigo de 11 dígitos.
