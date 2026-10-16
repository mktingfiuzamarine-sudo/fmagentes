import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDependencies } from "../app";
import { INSTANCE_STATUS } from "@fmagentes/shared";

const WEBHOOK_EVENTS = ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"];

export function registerInstanceRoutes(app: FastifyInstance, deps: AppDependencies): void {
  /** A database failure is a 500, never an empty list or a 404 that hides it. */
  function databaseFailed(reply: FastifyReply, error: unknown, what: string) {
    app.log.error({ err: error }, `Supabase ${what} failed`);
    return reply.code(500).send({ error: "database unavailable" });
  }

  app.post("/instances", async (request, reply) => {
    const body = request.body as { name?: unknown } | null;
    const name = body && typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return reply.code(400).send({ error: "name is required" });

    try {
      await deps.evolutionApi.createInstance(name, {
        url: `${deps.config.publicWebhookUrl}/webhooks/evolution`,
        events: WEBHOOK_EVENTS,
        headers: { apikey: deps.config.webhookSecret },
      });
    } catch (error) {
      app.log.error({ err: error }, "Evolution createInstance failed");
      return reply.code(502).send({ error: "evolution unavailable" });
    }

    const { data, error } = await deps.supabase
      .from("instances")
      .insert({ name, evolution_instance_id: name, status: INSTANCE_STATUS.CREATED })
      .select("*")
      .single();
    if (error) return reply.code(500).send({ error: "persist failed" });
    return reply.code(201).send(data);
  });

  app.get("/instances", async (_request, reply) => {
    const { data, error } = await deps.supabase.from("instances").select("*").order("created_at", { ascending: false });
    if (error) return databaseFailed(reply, error, "instance list");
    return data ?? [];
  });

  app.get("/instances/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { data, error } = await deps.supabase.from("instances").select("*").eq("id", id).maybeSingle();
    if (error) return databaseFailed(reply, error, "instance lookup");
    if (!data) return reply.code(404).send({ error: "not found" });
    return data;
  });

  app.get("/instances/:id/qr", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { data, error } = await deps.supabase.from("instances").select("id, evolution_instance_id").eq("id", id).maybeSingle();
    if (error) return databaseFailed(reply, error, "instance lookup");
    if (!data) return reply.code(404).send({ error: "not found" });
    const row = data as { evolution_instance_id: string };

    try {
      const qr = await deps.evolutionApi.connectInstance(row.evolution_instance_id);
      // Evolution returns no QR for an already-paired instance; writing
      // 'connecting' in that case would corrupt the stored lifecycle state.
      if (qr.qrcode !== null) {
        // The QR is still good without the status write; connection.update fixes the status later.
        const { error } = await deps.supabase.from("instances").update({ status: INSTANCE_STATUS.CONNECTING }).eq("id", id);
        if (error) app.log.warn({ err: error, instance: id }, "could not mark instance as connecting");
      }
      return reply.code(200).send(qr);
    } catch (error) {
      app.log.error({ err: error }, "Evolution connectInstance failed");
      return reply.code(502).send({ error: "evolution unavailable" });
    }
  });

  app.delete("/instances/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { data, error } = await deps.supabase.from("instances").select("id, evolution_instance_id").eq("id", id).maybeSingle();
    if (error) return databaseFailed(reply, error, "instance lookup");
    if (!data) return reply.code(404).send({ error: "not found" });
    const row = data as { evolution_instance_id: string };

    try {
      await deps.evolutionApi.deleteInstance(row.evolution_instance_id);
    } catch (error) {
      app.log.error({ err: error }, "Evolution deleteInstance failed");
      return reply.code(502).send({ error: "evolution unavailable" });
    }

    // Evolution treats an unknown instance as already deleted, so retrying the
    // whole DELETE after this failure is safe and removes the orphaned row.
    const { error: deleteError } = await deps.supabase.from("instances").delete().eq("id", id);
    if (deleteError) return databaseFailed(reply, deleteError, "instance delete");
    return reply.code(204).send();
  });
}
