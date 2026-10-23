# CRM Fiuza Marine — 4 funis, ficha náutica e coleta pela IA — Design

**Data:** 2026-10-23
**Repositórios afetados:**
- CRM: `C:\Users\Dell\Desktop\aula` (GitHub `mktingfiuzamarine-sudo/agentes_ia`), branch `main` em `3a5623c`. Supabase `nzeghgeytskpaqplgngj`.
- fmagentes: este repositório, `master` em `8253b47`. Pacote `packages/agent` (ferramentas da IA) e `apps/api` (nomes de clientes na inbox).

## Intenção

A Fiuza Marine é uma empresa náutica que vende barcos/lanchas, jet skis e
motores de popa, vende consórcios, vende peças e acessórios e faz manutenção.
O CRM atual é genérico: um único funil fixo (Lead → Contato → Proposta →
Negociação → Fechado), clientes com nome/e-mail/telefone/empresa/CPF e cada
usuário enxergando só os próprios dados.

O CRM passa a refletir o negócio real: **4 funis**, uma **ficha de cliente
com as embarcações que ele já tem**, e **números dos documentos do ERP Olist**
(proposta, pedido de venda, OS) em cada negócio.

O dono tem um medo explícito: que campos obrigatórios deixem o atendimento
**demorado e pesado**. Por isso a regra central é:

> A IA conversa naturalmente pelo WhatsApp e vai gravando os dados no CRM à
> medida que o cliente os menciona. Ela nunca vira um formulário, nunca é
> barrada por campo obrigatório e nunca insiste em dado que o cliente não quer
> dar. A obrigatoriedade é uma trava **para a equipe**, aplicada só quando um
> humano avança o card de etapa.

## Objetivos

1. 4 funis com etapas próprias, cada um com seu quadro de arrastar cards.
2. Campos por funil, com obrigatoriedade a partir de certas etapas, aplicada
   quando alguém da equipe move o card (o CRM diz o que falta e permite
   preencher ali mesmo).
3. Ficha de cliente ampliada (CPF ou CNPJ, WhatsApp, telefone fixo,
   aniversário, origem do lead, quem indicou).
4. Várias embarcações/motores por cliente, com campos que variam pelo tipo.
5. Campos para os números do Olist digitados à mão (proposta, pedido de
   venda, OS).
6. Toda a equipe vê todos os clientes e negócios.
7. A IA do WhatsApp cadastra e completa a ficha, as embarcações e os negócios
   aos poucos, durante a conversa.

## Fora do escopo (agora)

- **Integração com a API do Olist** (buscar valor/situação pelo número). É o
  próximo projeto; os campos de número já ficam prontos para ela.
- **Editor de funis/campos pela tela.** Funis, etapas e campos são fixos no
  código/banco para a Fiuza Marine.
- **Campo "valor" digitado à mão** em Vendas, Peças e Manutenção. Valores
  vivem nas propostas do Olist e não são tratados de forma avulsa no CRM.
- Responsável por negócio, permissões por papel, relatórios/dashboards de
  vendas, lembretes de aniversário.

## Anti-objetivos (seria um fracasso mesmo funcionando)

- A IA fazer uma bateria de perguntas para preencher a ficha, ou travar o
  atendimento por falta de algum dado.
- A IA perguntar, sugerir ou gravar qualquer valor em dinheiro (exceção nenhuma).
- A IA mover cards de etapa.
- Perder ou embaralhar os dados reais que já existem no CRM.

## Decisões do dono (como foram decididas)

### Funis e etapas

| Funil | Etapas |
|---|---|
| 1. Vendas | Lead → Visita → Proposta → Negociação → Fechado |
| 2. Consórcios | Lead → Documentação → Contrato Assinado → Contemplado → Encerrado |
| 3. Peças e Acessórios | Lead → Orçamento → Pedido Confirmado → Entregue |
| 4. Serviços de Manutenção | Orçamento Solicitado → Aprovado → Em Execução → Entregue → Pago |

Manutenção cobre motor de popa, jet ski e barco/lancha.

### Campos do negócio e obrigatoriedade

"A partir de X" vale para X e todas as etapas seguintes do mesmo funil.

**Vendas** (o que o cliente quer COMPRAR)
- Tipo de produto (seleção única: Barco/Lancha, Jet Ski, Motor de Popa) — obrigatório a partir de Proposta
- Marca (texto) — obrigatório a partir de Proposta
- Modelo (texto) — obrigatório a partir de Proposta
- Ano (número) — obrigatório a partir de Proposta
- Nº da proposta (Olist) — obrigatório a partir de Proposta
- Nº do pedido de venda (Olist) — opcional

**Consórcios**
- Valor do consórcio (moeda) — obrigatório a partir de Contrato Assinado. É o
  valor da carta, que vem do contrato, não de proposta do Olist; por isso é o
  único valor em dinheiro do CRM.
- Administradora (texto) — opcional
- Número do contrato (texto) — obrigatório a partir de Contrato Assinado

**Peças e Acessórios**
- Descrição da peça (texto) — obrigatório a partir de Orçamento
- Nº da proposta (Olist) — obrigatório a partir de Orçamento
- Nº do pedido de venda (Olist) — obrigatório a partir de Pedido Confirmado

**Serviços de Manutenção**
- Embarcação/motor do cliente que vai para o serviço (referência a um item da
  ficha do cliente) — obrigatório a partir de Aprovado. O "tipo de equipamento"
  da lista original sai daí (não é digitado de novo).
- Descrição do serviço (texto) — obrigatório a partir de Aprovado
- Nº da proposta (Olist) — opcional
- Nº da OS (Olist) — obrigatório a partir de Aprovado

Processo no Olist, para contexto: tudo começa numa **proposta**; proposta de
serviço vira **OS**; proposta só de produtos (peças, acessórios, barcos, jet
skis, motores) vira **pedido de venda**. Números são texto livre (o formato
do Olist não é validado nesta fase).

### A trava de etapa

- Vale quando um humano move o card (arrastar no quadro ou outro controle).
  Se faltar campo exigido pela etapa de destino, o movimento não acontece e o
  CRM abre um formulário com exatamente os campos que faltam; preencheu e
  salvou, o card vai.
- A regra precisa valer no banco (no caminho que move o card), não só na tela.
- A IA nunca move cards, então nunca esbarra na trava.

### Contatos (ficha do cliente)

- Nome completo (já existe)
- E-mail (já existe)
- CPF ou CNPJ — o campo atual só aceita CPF; passa a aceitar os dois, com
  validação de dígitos de cada um. Unicidade continua global.
- WhatsApp (telefone) — é o `phone` atual, pelo qual a IA reconhece o cliente
- Telefone fixo (telefone)
- Data de aniversário (data)
- Origem do lead (seleção única: Instagram, Facebook, Indicação, Google Meu
  Negócio, Site Fiuza Marine, Lpage Motores, Lpage Serviços, Outros). **Não**
  há opção "WhatsApp": a origem é como o cliente conheceu a empresa, não o
  canal pelo qual escreveu.
- Quem indicou (texto) — só aparece quando Origem = Indicação
- Empresa e observações continuam existindo.

### Embarcações do cliente (o que ele JÁ TEM)

Um cliente pode ter **vários** itens. Cada item é de um tipo, e os campos
dependem do tipo:

**Barco/Lancha**
- Tipo de casco (Alumínio mono casco, Fibra mono casco, Catamarã, Outro)
- Estaleiro/marca (texto)
- Tamanho em metros (número) e em pés (número)
- Ano de fabricação do barco (número)
- Quantidade de motores (Único, Parelha, Trelha)
- Tipo de motor (Motor de popa, Motor de centro)
- Potência HP (número)
- Ano de fabricação do motor (número)

**Motor de popa (independente/portátil)** — cadastrado sozinho, sem barco
- Marca (Yamaha, Evinrude, Johnson, Mercury, Suzuki, Hidea, Tohatsu, Honda)
- Potência HP (número)
- Modelo/série (texto)
- Ano de fabricação (número)

**Jet Ski**
- Marca (Sea-Doo, Yamaha, Kawasaki, Honda)
- Modelo (texto)
- Ano de fabricação (número)

Nenhum campo de embarcação é obrigatório (a IA pode criar o item só com o
tipo e o que o cliente contou).

### Visibilidade

Todos os usuários autenticados do CRM veem e editam todos os clientes,
embarcações e negócios. Continua-se registrando quem criou cada registro
(`user_id`), só como informação.

### Comportamento da IA (WhatsApp)

- Conversa normal; quando o cliente menciona algo que tem lugar no CRM, grava.
  Ex.: "tenho uma lancha de fibra de 2018 com dois Mercury 150" → item
  Barco/Lancha com casco Fibra mono casco, ano 2018, quantidade Parelha,
  tipo Motor de popa, potência 150 (marca do motor vai para observação do item
  se não houver campo; ver "Deixado ao construtor").
- Pergunta só o que é necessário para o próximo passo do atendimento, uma
  coisa por vez. Se o cliente não souber ou não quiser, segue em frente.
- Pergunta **uma única vez**, de forma leve, como o cliente conheceu a Fiuza
  Marine, e grava a origem (e quem indicou, se for indicação).
- Abre o negócio no funil certo pelo assunto (compra → Vendas; consórcio →
  Consórcios; peça/acessório → Peças; conserto/revisão → Manutenção), sempre
  na **primeira etapa** do funil, e vai preenchendo os campos do negócio que
  surgirem. Em Manutenção, liga o negócio à embarcação/motor da ficha (criando
  o item se ainda não existir).
- Nunca pergunta, sugere ou grava valores; nunca move cards.
- Continua podendo transferir para humano como hoje.

## Decisões minhas (o dono pode vetar ao ler)

1. **Conversão metros ↔ pés:** quem preencher um, o outro é calculado
   (1 pé = 0,3048 m), arredondado a 1 casa; editar um recalcula o outro.
2. **Dados que já existem:** os negócios atuais vão para o funil Vendas,
   com mapeamento lead→Lead, contato→Visita, proposta→Proposta,
   negociacao→Negociação, fechado→Fechado. Eles não são barrados pela trava
   retroativamente (a trava só age no próximo movimento). A coluna de valor
   atual não é apagada do banco; só deixa de aparecer na tela. Clientes
   existentes ficam como estão (CPF atual vira o novo CPF/CNPJ; `phone` vira
   WhatsApp).
3. **Título do card:** continua existindo. Quem cria escreve; a IA gera um
   título curto descritivo (ex.: "Revisão Mercury 150 HP", "Compra jet ski").
4. **Negócio duplicado pela IA:** antes de abrir negócio, a IA vê se o
   cliente já tem negócio aberto (fora da última etapa) no mesmo funil; se
   tiver, atualiza esse em vez de criar outro.
5. **IA só preenche campo vazio:** nunca sobrescreve valor já salvo (cliente,
   embarcação ou negócio). Se o cliente informar algo diferente do salvo, a IA
   acrescenta uma linha nas observações do registro (ex.: "Cliente informou
   e-mail diferente: x@y.com") e a equipe decide.
6. **Origem do lead:** a IA pergunta só enquanto o campo estiver vazio e no
   máximo uma vez por conversa. Sem coluna de "já perguntado".

## Restrições

- Regras de privacidade do agente que continuam valendo (vêm do sub-projeto 4):
  - Telefone do WhatsApp só identifica cliente por correspondência no `phone`.
  - Um CPF digitado por alguém que já existe no CRM **vincula**, mas
    `attachPhone` nunca grava `phone` (só anota em observações como "não
    verificado") e a IA não revela dados do cadastro vinculado.
  - Estender o mesmo cuidado ao CNPJ.
- A IA acessa o CRM com a service key (passa por cima do RLS), só no servidor.
  Ela não pode, por esse caminho, mover etapa: a ferramenta de negócio só cria
  na primeira etapa e atualiza campos.
- Cada ferramenta que grava algo é uma chamada à parte; o limite atual de
  `MAX_STEPS = 3` no `LlmResponder` provavelmente precisa subir para a IA
  poder gravar mais de uma coisa e ainda responder na mesma vez.
- `phone_digits` e `search_vector` são colunas geradas: nunca entram em
  INSERT/UPDATE.
- Migrações novas do CRM numeradas a partir de `011_`, no padrão das existentes
  (RLS, GRANTs por coluna, RPCs `SECURITY DEFINER` com `search_path` fixo,
  REVOKE de `anon`).
- Os funis atuais usam RPCs (`create_deal`, `move_deal_to_stage`,
  `reorder_deals`) com lock de posição por `(user_id, stage)`. Com dados
  compartilhados, a posição passa a ser por `(funil, etapa)`, sem filtro por
  dono.
- O dashboard do fmagentes mostra o nome do cliente vindo do CRM
  (`apps/api/src/dashboard/customerNames.ts`); isso não pode quebrar.
- Identidade visual "dark náutico" atual do CRM é mantida.

## Deixado ao construtor

- Forma das tabelas (ex.: tabela de embarcações com coluna de tipo e campos
  por tipo com CHECKs, ou tabelas separadas; campos por funil em colunas ou em
  tabela por funil). Requisito: tipos e listas de opções garantidos no banco.
- Onde a regra de obrigatoriedade mora (função SQL única chamada pelo RPC de
  mover etapa é o caminho óbvio) e como a tela descobre o que falta.
- Como a tela mostra os 4 funis (abas, seletor) e onde ficam as embarcações
  na ficha do cliente.
- O conjunto exato de ferramentas da IA (nomes, granularidade) e as instruções
  de plataforma correspondentes em `buildPrompt.ts`. Hoje existe só
  `cadastrar_cliente` (exige nome, CPF e e-mail juntos) e
  `transferir_para_humano`.
- Se marca do motor de um Barco/Lancha merece campo próprio (a lista do dono
  não tem; hoje iria para observações do item).
- Testes: o padrão dos dois repositórios é TDD; testes de RLS/RPC no CRM e
  testes unitários das ferramentas no `packages/agent`.

## Pendências para o dono

Revisão do construtor feita em 2026-10-23. Duas perguntas foram levadas ao
dono e **ainda não foram respondidas** (ele pausou a sessão). Documento NÃO
aprovado ainda.

1. **O que a IA exige antes de começar a gravar?** Hoje, para número
   desconhecido, `customerContextBlock` manda pedir nome + CPF + e-mail antes
   de prosseguir e `cadastrar_cliente` exige os três — contradiz a regra
   central. Sugestão levada: criar o cliente assim que souber o nome (com o
   WhatsApp da conversa) e pedir CPF/CNPJ e e-mail só quando o atendimento
   precisar (ex.: ao gerar proposta). Implica novo tipo de vínculo além de
   `cpf | created`, novo prompt e novos métodos no `CrmPort`.
2. **Vínculo por CPF/CNPJ digitado (não verificado):** sugestão levada: a IA
   pode criar negócios e embarcações novos nesse cliente, mas não lê nem altera
   o que já existe (a equipe confere). Custo aceito: negócio duplicado de vez
   em quando, já que a checagem de duplicidade (decisão 4) não roda nesse caso.
   Implica as ferramentas saberem como o vínculo foi feito (`CustomerContext`
   hoje só tem registered/unregistered + nome).
