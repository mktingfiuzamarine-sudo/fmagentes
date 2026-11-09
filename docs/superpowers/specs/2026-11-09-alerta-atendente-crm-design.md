# Alerta de "pediu atendente" no quadro do CRM — Design

**Data:** 2026-11-09
**Pedido do dono (Fiuza Marine):** quando um cliente pede para falar com uma pessoa no WhatsApp, o card do assunto deve mudar de cor no quadro do CRM, para alertar a equipe.

**Repositórios afetados:**
- fmagentes (`C:\Users\Dell\Desktop\fmagentes`, master): `packages/agent`, `packages/messaging`, `apps/worker`, `apps/api`, migração nova em `supabase/migrations` (projeto Supabase `odqqiteoskmfpwrlqyrb`).
- CRM (`C:\Users\Dell\Desktop\aula`, main): migração `015`, quadro `app/dashboard/pipeline`. Banco `nzeghgeytskpaqplgngj` é **produção**: migração só com dry-run (begin/rollback) e "ok" do dono antes de aplicar.

## Por quê

A equipe trabalha olhando o **quadro do CRM** e o **painel de atendimento** (dashboard do fmagentes). Hoje o pedido de atendente só aparece no painel ("aguardando atendente"). Quem está no quadro do CRM não percebe que um cliente está esperando.

## O que o dono decidiu

1. **Só o card do assunto da conversa** muda de cor, não todos os cards abertos do cliente.
2. Três estados, ligados aos botões que já existem no painel de atendimento:
   - 🔴 **Esperando atendente**: o cliente pediu uma pessoa (handoff) e ninguém assumiu. O card mostra "esperando atendente há X min".
   - 🔵 **Em atendimento**: alguém clicou em **Assumir** no painel. O card mostra "em atendimento: [nome do atendente]".
   - ⚪ **Normal**: o atendente clicou em **Devolver ao robô**.
   - Se o atendente **soltar** a conversa (unassign) sem devolver ao robô, o card volta a 🔴.
3. O processo combinado: a equipe responde **pelo painel**, não pelo celular da empresa (resposta pelo celular não muda o estado).

## Decisões minhas (o dono aprovou o desenho em conversa)

- **Quem escolhe o card:** a IA, no momento da transferência. A ferramenta `transferir_para_humano` ganha um `negocio_id` opcional (o negócio do assunto, da lista "Negócios abertos" ou o que ela acabou de registrar no mesmo turno). Se faltar ou não for um negócio aberto daquele cliente no escopo da conversa, cai para o **negócio aberto atualizado mais recentemente** do cliente. Se o cliente não tiver nenhum negócio aberto (ou a conversa não estiver ligada a um cliente do CRM), não há card para colorir — o alerta fica só no painel.
- **O quadro se atualiza sozinho** a cada ~30 s (hoje só com F5). Sem isso o alerta não serve.
- **Falha ao gravar o alerta no CRM nunca bloqueia** a transferência, o Assumir, o Soltar ou o Devolver: registra no log e segue.
- O alerta é **só leitura** no CRM (a equipe não edita pelo card); quem muda o estado são os botões do painel.

## Casos de borda (decisões minhas, após a revisão do construtor)

- **Negócio fechado ou apagado com alerta:** o quadro só pinta cards que não estão na última etapa do funil. A API só grava o alerta se o negócio ainda existir e não estiver na última etapa (`update ... where id = $1 and stage <> última etapa`); se não achar, segue sem erro. Fechar um card com alerta não precisa de trigger: o card some da cor ao fechar, e o Devolver limpa o que restar.
- **Nova transferência enquanto já está transferida/assumida:** não acontece — com a conversa em "aguardando atendente" a IA não roda; só há nova transferência depois do Devolver, que já limpou o alerta. O passo 5 ("limpar o anterior") é **por conversa**: limpa só o `handoff_deal_id` desta conversa, nunca um card marcado por outra conversa do mesmo cliente.
- **Negócio de reserva (fallback):** o negócio aberto atualizado mais recentemente do cliente, **em qualquer funil**, dentro do escopo de CRM da conversa (vínculo verificado: todos os negócios do cliente; não verificado: só os criados por esta conversa — o mesmo escopo que o agente já usa). Vale também para `handOffAfterFailure`.
- **`updated_at`:** a gravação do alerta **não** deve mexer em `deals.updated_at` (ele decide o "mais recente" e ordenações). A migração 015 ajusta o trigger `deals_updated_at` para não atualizar `updated_at` quando só as colunas `attention*` mudaram.
- **Nome do atendente:** o nome exibido que o painel já usa (`displayNames` / `team_members.display_name`, com e-mail como reserva).

## Fora do escopo

Alerta sonoro, notificação no celular, alerta por tempo (piscar após N min), mudar cor de vários cards, botão no CRM para limpar o alerta, publicar o CRM/painel na internet (deploy é outro trabalho).

## Dados

**CRM — `deals` ganha três colunas (migração 015):**
- `attention text` — `null` (normal), `'waiting'` ou `'in_service'` (CHECK).
- `attention_since timestamptz` — quando entrou no estado atual (para "há X min").
- `attention_by text` — nome do atendente em `in_service`; `null` nos outros estados.
- Escrita só pelo service role (agente/API). A equipe (authenticated) lê, não escreve essas colunas (o CRM já restringe colunas atualizáveis desde a migração 006 — manter essas fora da lista). Nada muda nas travas de etapa/campos obrigatórios.

**fmagentes — `conversations` ganha `handoff_deal_id uuid null`** (id do negócio no CRM, sem FK por ser outro banco), gravado na transferência e usado pela API para achar o card no Assumir/Soltar/Devolver. Limpo no Devolver.

## Fluxo

1. **Transferência (worker):** ao concluir um handoff, resolver o negócio (regra acima), gravar `conversations.handoff_deal_id` e no CRM `attention='waiting', attention_since=now(), attention_by=null` nesse negócio. Também na transferência automática por falha (`handOffAfterFailure`), com a regra do negócio mais recente.
2. **Assumir (API `/conversations/:id/assign`):** se a conversa tem `handoff_deal_id`, CRM `attention='in_service', attention_since=now(), attention_by=<nome exibido do atendente>`.
3. **Soltar (API `/unassign`):** CRM volta a `'waiting'`, `attention_since=now()`, `attention_by=null`.
4. **Devolver ao robô (API `/resume`):** CRM `attention=null, attention_since=null, attention_by=null`; `handoff_deal_id=null`.
5. **Nova transferência do mesmo cliente:** repete o passo 1 (pode ser outro card). Se o negócio anterior ainda estava marcado e é outro card, limpar o anterior.

A API já tem acesso ao CRM (`CRM_SUPABASE_URL`/`CRM_SUPABASE_SERVICE_KEY`, hoje usado para nomes de clientes); se não estiverem configurados, o alerta simplesmente não é gravado.

## Quadro do CRM

- Card em `waiting`: borda/fundo em vermelho (token de cor do tema, legível em claro e escuro) + linha "Esperando atendente · há 12 min".
- Card em `in_service`: azul + "Em atendimento: Ana".
- O tempo "há X min" conta a partir de `attention_since`, recalculado a cada atualização.
- Atualização automática ~30 s sem atrapalhar arrastar/soltar nem um diálogo aberto (o construtor decide entre polling do `router.refresh()` e Supabase Realtime; polling é suficiente).

## Testes esperados

- Agente: `transferir_para_humano` com e sem `negocio_id`; id inválido cai para o mais recente.
- Worker/messaging: handoff grava `handoff_deal_id` e chama o CRM; falha no CRM não impede o handoff.
- API: assign/unassign/resume atualizam o CRM certo; conversa sem `handoff_deal_id` não chama o CRM; falha no CRM não muda a resposta HTTP.
- CRM: SQL de teste da 015 (dry-run em transação desfeita): colunas, CHECK, authenticated não consegue escrever `attention*`.
- Teste manual com o WhatsApp do dono: pedir atendente → card vermelho; Assumir → azul com nome; Soltar → vermelho; Devolver → normal.

## Deixado para o construtor

Nomes internos de funções/arquivos, forma exata da atualização automática, tons exatos das cores (dentro dos tokens do tema), ordem dos commits.
