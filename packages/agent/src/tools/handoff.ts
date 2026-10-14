import { tool } from "ai";
import { z } from "zod";

export const HANDOFF_TOOL_NAME = "transferir_para_humano";

/**
 * No `execute` on purpose: calling it ends the generateText loop, and the
 * responder turns the call into a `handoff` result.
 */
export const handoffTool = tool({
  description:
    "Transfere a conversa para um atendente humano. Use quando o cliente pedir um humano ou quando você não souber responder. Depois de chamar, não escreva mais nada.",
  parameters: z.object({
    resumo: z
      .string()
      .describe("Resumo para o atendente humano: quem é o cliente, o que ele quer e os dados já coletados."),
  }),
});
