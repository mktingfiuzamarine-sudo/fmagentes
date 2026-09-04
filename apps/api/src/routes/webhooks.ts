import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";
import { parseEvolutionEvent, ingestInboundMessage } from "@fmagentes/messaging";
import { mapConnectionState, INSTANCE_STATUS } from "@fmagentes/shared";

export function registerWebhookRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/webhooks/evolution", async (request, reply) => {
    if (request.headers.apikey !== deps.config.webhookSecret) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const event = parseEvolutionEvent(request.body);
    if (!event) {
      app.log.info("Ignoring unrecognised Evolution webhook event");
      return reply.code(200).send({ received: false });
    }

    try {
      if (event.type === "messages.upsert") {
        if (event.fromMe) return reply.code(200).send({ received: true });

        const ingested = await ingestInboundMessage(deps, event);
        if (ingested) {
          await deps.inboundQueue.add("inbound-messages", ingested);
        }
        return reply.code(200).send({ received: true });
      }

      if (event.type === "connection.update") {
        const status = mapConnectionState(event.state);
        const patch: Record<string, unknown> = { status };
        if (status === INSTANCE_STATUS.CONNECTED) {
          const info = await deps.evolutionApi.fetchInstance(event.instanceName);
          if (info?.number) patch.phone_number = info.number;
        }
        await deps.supabase.from("instances").update(patch).eq("evolution_instance_id", event.instanceName);
        return reply.code(200).send({ received: true });
      }

      // qrcode.updated — acknowledged; GET /instances/:id/qr fetches fresh QR on demand.
      app.log.info({ instance: event.instanceName }, "qrcode.updated");
      return reply.code(200).send({ received: true });
    } catch (error) {
      app.log.error({ err: error }, "Webhook processing failed");
      return reply.code(500).send({ received: false });
    }
  });
}
