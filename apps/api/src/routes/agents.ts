import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dashboardStore, type AppDependencies } from "../app";
import { pickAgent, type AgentInput, type AgentRow } from "../dashboard/store";
import { isUuid } from "../dashboard/uuid";

const agentFields = {
  name: z.string().trim().min(1).max(100),
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().trim().min(1).max(100),
  systemPrompt: z.string().max(20000),
  isActive: z.boolean(),
};
const handoffMessage = z.string().trim().min(1).max(1000);

const createSchema = z.object({
  instanceId: z.string().refine(isUuid),
  ...agentFields,
  handoffMessage: handoffMessage.optional(),
});
const updateSchema = z.object({ ...agentFields, handoffMessage });

function toDto(agent: AgentRow) {
  return {
    id: agent.id,
    instanceId: agent.instanceId,
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    handoffMessage: agent.handoffMessage,
    isActive: agent.isActive,
  };
}

function providerWarning(deps: AppDependencies, provider: AgentInput["provider"]) {
  const available = deps.config.providers?.[provider] ?? false;
  return available ? {} : { warning: "provider-key-missing" as const };
}

export function registerAgentRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get("/agents", async () => {
    const instances = await dashboardStore(deps).listInstancesWithAgents();
    return instances.map((instance) => {
      const agent = pickAgent(instance.agents);
      return {
        instance: { id: instance.id, name: instance.name, status: instance.status },
        agent: agent ? toDto(agent) : null,
      };
    });
  });

  app.post("/agents", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid agent", issues: parsed.error.issues });

    const { instanceId, ...input } = parsed.data;
    const store = dashboardStore(deps);
    if (!(await store.instanceExists(instanceId))) return reply.code(404).send({ error: "instance not found" });
    if ((await store.countAgents(instanceId)) > 0) {
      return reply.code(409).send({ error: "instance already has an agent" });
    }

    const agent = await store.createAgent(instanceId, input);
    return reply.code(201).send({ agent: toDto(agent), ...providerWarning(deps, input.provider) });
  });

  app.put("/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "agent not found" });

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid agent", issues: parsed.error.issues });

    const agent = await dashboardStore(deps).updateAgent(id, parsed.data);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    return { agent: toDto(agent), ...providerWarning(deps, parsed.data.provider) };
  });
}
