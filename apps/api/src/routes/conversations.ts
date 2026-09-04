import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";
import { sendMessage, ConversationNotFoundError } from "@fmagentes/messaging";

export function registerConversationRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { text?: unknown } | null;
    const text = body && typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "text is required" });

    try {
      const sent = await sendMessage(deps, { conversationId: id, text });
      return reply.code(201).send(sent);
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return reply.code(404).send({ error: "conversation not found" });
      }
      app.log.error({ err: error }, "Outbound send failed");
      return reply.code(502).send({ error: "send failed" });
    }
  });
}
