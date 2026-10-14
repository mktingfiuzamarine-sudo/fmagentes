import type { CoreMessage } from "ai";
import type { AgentConfig, CustomerContext, HistoryMessage } from "@fmagentes/messaging";

export const PLATFORM_INSTRUCTIONS = [
  "Você é um atendente respondendo clientes pelo WhatsApp.",
  "- Escreva mensagens curtas e simples, em texto puro, sem markdown (sem asteriscos, títulos ou listas com marcadores).",
  "- Nunca invente informações que não estejam nas instruções do negócio. Quando não souber, colete os dados básicos e transfira para um atendente humano.",
  "- Se o cliente pedir para falar com um humano, chame a ferramenta transferir_para_humano imediatamente. Se faltarem dados básicos, peça uma única vez; se o cliente insistir, transfira mesmo assim.",
  "- Antes de transferir, colete o que as instruções do negócio pedirem e escreva no campo resumo um resumo do atendimento para o atendente humano.",
  "- Depois de chamar transferir_para_humano, não escreva mais nada: a mensagem de transferência é enviada automaticamente.",
].join("\n");

export function customerContextBlock(customer: CustomerContext): string {
  if (customer.status === "unregistered") {
    return "Cliente SEM cadastro. Antes de prosseguir com o atendimento, peça nome completo, CPF e e-mail e chame cadastrar_cliente.";
  }
  return customer.name ? `Cliente cadastrado: ${customer.name}.` : "Cliente cadastrado.";
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
    { role: "system", content: `## Cliente\n${customerContextBlock(input.customer)}` },
    // Spelled out per role: CoreMessage is a discriminated union, so a
    // `role: "user" | "assistant"` object literal would not type-check.
    ...history.map(
      (message): CoreMessage =>
        message.role === "user"
          ? { role: "user", content: message.content }
          : { role: "assistant", content: message.content },
    ),
  ];
}
