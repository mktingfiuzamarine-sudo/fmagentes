import type { FastifyInstance } from "fastify";
import { dashboardStore, type AppDependencies } from "../app";
import { isUuid } from "../dashboard/uuid";
import type { InboxView } from "../dashboard/store";
import { resolveCustomer, toListItem, toMessage } from "../dashboard/present";

const VIEWS: readonly InboxView[] = ["handoff", "all", "mine"];
const DETAIL_MESSAGE_LIMIT = 100;

export function registerInboxRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get("/conversations", async (request, reply) => {
    const { view = "handoff" } = request.query as { view?: string };
    if (!VIEWS.includes(view as InboxView)) return reply.code(400).send({ error: "invalid view" });

    const store = dashboardStore(deps);
    const me = request.user!.id;
    const [rows, counts] = await Promise.all([store.listInbox(view as InboxView, me), store.countInbox(me)]);
    const names = await store.displayNames(rows.flatMap((row) => (row.assignedTo ? [row.assignedTo] : [])));
    return { items: rows.map((row) => toListItem(row, names)), counts };
  });

  app.get("/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "conversation not found" });

    const store = dashboardStore(deps);
    const row = await store.getInboxRow(id);
    if (!row) return reply.code(404).send({ error: "conversation not found" });

    const [messages, customer] = await Promise.all([
      store.listMessages(id, DETAIL_MESSAGE_LIMIT),
      resolveCustomer(row, deps.customerNames, request.log),
    ]);
    const people = [row.assignedTo, ...messages.map((m) => m.sentBy)].filter((v): v is string => Boolean(v));
    const names = await store.displayNames(people);

    return { ...toListItem(row, names), messages: messages.map((m) => toMessage(m, names)), customer };
  });

  app.post("/conversations/:id/assign", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "conversation not found" });

    const store = dashboardStore(deps);
    const user = request.user!;
    const outcome = await store.assign(id, user.id);
    if (outcome === "not-found") return reply.code(404).send({ error: "conversation not found" });
    if (outcome === "not-awaiting") return reply.code(409).send({ error: "conversation is not awaiting a human" });

    const names = await store.displayNames([user.id]);
    return { assignedTo: { id: user.id, displayName: names.get(user.id) ?? user.email ?? user.id } };
  });

  app.post("/conversations/:id/unassign", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "conversation not found" });
    const ok = await dashboardStore(deps).unassign(id);
    if (!ok) return reply.code(404).send({ error: "conversation not found" });
    return { assignedTo: null };
  });
}
