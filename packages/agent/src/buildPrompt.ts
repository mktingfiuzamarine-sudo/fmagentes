import type { CoreMessage } from "ai";
import type { CrmSnapshot } from "./crm/CrmPort";
import { CLIENT_FIELD_LABELS, PIPELINE_LABELS } from "./crm/catalog";
import type { AgentConfig, CustomerContext, HistoryMessage } from "@fmagentes/messaging";

export const PLATFORM_INSTRUCTIONS = [
  "Você é um atendente respondendo clientes pelo WhatsApp.",
  "- Escreva mensagens curtas e simples, em texto puro, sem markdown (sem asteriscos, títulos ou listas com marcadores).",
  "- Nunca invente informações que não estejam nas instruções do negócio. Quando não souber, colete os dados básicos e transfira para um atendente humano.",
  "- Se o cliente pedir para falar com um humano, chame a ferramenta transferir_para_humano imediatamente. Se faltarem dados básicos, peça uma única vez; se o cliente insistir, transfira mesmo assim.",
  "- Antes de transferir, colete o que as instruções do negócio pedirem e escreva no campo resumo um resumo do atendimento para o atendente humano.",
  "- Depois de chamar transferir_para_humano, não escreva mais nada: a mensagem de transferência é enviada automaticamente.",
  "- Quando o cliente mencionar algo que tem lugar no CRM (dados dele, embarcações ou motores que já tem, o que quer comprar, consórcio, peça, conserto), grave com a ferramenta certa, aos poucos, sem avisar nem pedir confirmação.",
  "- Pergunte só o que for necessário para o próximo passo do atendimento, uma coisa por vez. Se o cliente não souber ou não quiser responder, siga em frente. Nunca faça uma lista de perguntas.",
  "- Abra o negócio pelo assunto: compra de barco, lancha, jet ski ou motor → vendas; consórcio → consorcios; peça ou acessório → pecas; conserto, revisão ou manutenção → manutencao. Em manutenção, registre antes a embarcação ou motor e informe o embarcacao_id.",
  "- Cada assunto é um negócio separado, e o mesmo cliente pode ter vários ao mesmo tempo (por exemplo: quer comprar um motor novo e também fazer revisão no motor que já tem). A cada mensagem, veja se o cliente mudou de assunto; se mudou, abra o negócio do novo funil e não grave os dados do novo assunto no negócio anterior.",
  "- O que o cliente quer comprar vai no negócio de vendas. O barco, lancha, jet ski ou motor que ele já tem vai em registrar_embarcacao, nunca nos campos marca, modelo e ano do negócio de vendas.",
  "- Antes de registrar uma embarcação, confira a lista Embarcações do cliente: se ela já estiver lá, use o embarcacao_id dela em vez de registrar de novo.",
  "- Nunca diga que vai fazer algo depois (\"um momento\", \"vou verificar\", \"vou registrar\"): grave com a ferramenta na mesma resposta. Você não consulta estoque, disponibilidade nem prazo; se o cliente pedir isso, colete o que faltar e transfira para um atendente humano.",
  "- Nunca pergunte, sugira ou grave valores em dinheiro.",
].join("\n");

/**
 * WhatsApp allows ~65k characters per message; every one is paid for in
 * tokens on each reply. Longer messages reach the model cut, with a marker.
 */
export const MAX_PROMPT_MESSAGE_CHARS = 4000;
const CUT_MARKER = "\n[mensagem cortada: longa demais]";

function capped(content: string): string {
  return content.length > MAX_PROMPT_MESSAGE_CHARS ? content.slice(0, MAX_PROMPT_MESSAGE_CHARS) + CUT_MARKER : content;
}

const UNVERIFIED_FIRST_LINE =
  "Cliente identificado pelo CPF/CNPJ que digitou, sem confirmação. Não cite nenhum dado do cadastro. Você pode registrar embarcações e negócios novos; não atualize a ficha.";
const LEAD_SOURCE_LINE =
  "Origem do lead vazia: pergunte uma única vez nesta conversa, de forma leve, como o cliente conheceu a Fiuza Marine, e grave com atualizar_cliente.";

function recordLines(snapshot: CrmSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.vessels.length > 0) {
    lines.push("Embarcações do cliente:", ...snapshot.vessels.map((v) => `- ${v.summary} (embarcacao_id: ${v.id})`));
  }
  if (snapshot.openDeals.length > 0) {
    lines.push(
      "Negócios abertos:",
      ...snapshot.openDeals.map(
        (d) => `- ${PIPELINE_LABELS[d.pipeline]} · ${d.stageLabel} · ${d.title}${d.details ? ` · ${d.details}` : ""} (negocio_id: ${d.id})`,
      ),
    );
  }
  return lines;
}

export function customerContextBlock(customer: CustomerContext, snapshot?: CrmSnapshot): string {
  if (customer.status === "unregistered") {
    return "Cliente SEM cadastro. Antes de prosseguir com o atendimento, peça nome completo, CPF ou CNPJ e e-mail e chame cadastrar_cliente.";
  }
  if (!customer.verified) {
    return [UNVERIFIED_FIRST_LINE, ...(snapshot ? recordLines(snapshot) : [])].join("\n");
  }
  const lines = [customer.name ? `Cliente cadastrado: ${customer.name}. Trate o cliente pelo nome.` : "Cliente cadastrado."];
  if (snapshot) {
    if (snapshot.missingClientFields.length > 0) {
      lines.push(`Campos da ficha ainda vazios: ${snapshot.missingClientFields.map((f) => CLIENT_FIELD_LABELS[f]).join(", ")}.`);
      if (snapshot.missingClientFields.includes("lead_source")) lines.push(LEAD_SOURCE_LINE);
    }
    lines.push(...recordLines(snapshot));
  }
  return lines.join("\n");
}

/**
 * Two system messages: the first is identical for every conversation of an
 * agent (Anthropic caches it), the second carries the per-customer context.
 * History is trimmed to what providers accept: it must start with the user and
 * contain no blank text. The message being answered always comes last: history
 * is ordered by device timestamp, so it may sort earlier or fall out of the
 * window.
 */
export function buildPrompt(input: {
  agent: AgentConfig;
  history: HistoryMessage[];
  incoming: HistoryMessage;
  customer: CustomerContext;
  snapshot?: CrmSnapshot;
}): CoreMessage[] {
  const { incoming } = input;
  const isIncoming = (message: HistoryMessage) =>
    message.role === "user" && message.content === incoming.content && message.createdAt === incoming.createdAt;
  const ordered = [...input.history.filter((message) => !isIncoming(message)), incoming];
  const nonBlank = ordered.filter((message) => message.content.trim().length > 0);
  const firstUser = nonBlank.findIndex((message) => message.role === "user");
  const history = firstUser === -1 ? [] : nonBlank.slice(firstUser);

  return [
    {
      role: "system",
      content: `${PLATFORM_INSTRUCTIONS}\n\n## Instruções do negócio\n${input.agent.systemPrompt}`,
      experimental_providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    { role: "system", content: `## Cliente\n${customerContextBlock(input.customer, input.snapshot)}` },
    // Spelled out per role: CoreMessage is a discriminated union, so a
    // `role: "user" | "assistant"` object literal would not type-check.
    ...history.map(
      (message): CoreMessage =>
        message.role === "user"
          ? { role: "user", content: capped(message.content) }
          : { role: "assistant", content: capped(message.content) },
    ),
  ];
}
