import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, testAuth } from "./helpers/auth";
import { AGENT_ID, INSTANCE_ID, agentRow, fakeDashboardStore } from "./helpers/fakeDashboardStore";
import type { DashboardStore } from "../src/dashboard/store";

function deps(store: DashboardStore, providers = { anthropic: true, openai: true }): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: testAuth(),
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com", allowedUsers: TEST_ALLOWED_USERS, providers },
    dashboard: store,
  };
}

const VALID = {
  name: "Atendente",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  systemPrompt: "Você atende a Loja Exemplo.",
  handoffMessage: "Já te passo para alguém.",
  isActive: true,
};

describe("GET /agents", () => {
  it("401 without a token", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    expect((await app.inject({ method: "GET", url: "/agents" })).statusCode).toBe(401);
    await app.close();
  });

  it("one row per instance with the picked agent or null", async () => {
    const store = fakeDashboardStore({
      listInstancesWithAgents: vi.fn().mockResolvedValue([
        { id: INSTANCE_ID, name: "loja", status: "connected", agents: [agentRow({ isActive: false, createdAt: "1" }), agentRow({ id: "a2", createdAt: "2" })] },
        { id: "i2", name: "outra", status: "created", agents: [] },
      ]),
    });
    const app = buildApp(deps(store));

    const body = (await app.inject({ method: "GET", url: "/agents", headers: AUTH_HEADERS })).json();

    expect(body).toHaveLength(2);
    expect(body[0].instance).toEqual({ id: INSTANCE_ID, name: "loja", status: "connected" });
    expect(body[0].agent.id).toBe("a2");
    expect(body[0].agent).not.toHaveProperty("createdAt");
    expect(body[1].agent).toBeNull();
    await app.close();
  });
});

describe("POST /agents", () => {
  const create = (app: ReturnType<typeof buildApp>, payload: object) =>
    app.inject({ method: "POST", url: "/agents", payload, headers: AUTH_HEADERS });

  it("201 creates the agent for an instance without one", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    const response = await create(app, { instanceId: INSTANCE_ID, ...VALID });
    expect(response.statusCode).toBe(201);
    expect(store.createAgent).toHaveBeenCalledWith(INSTANCE_ID, VALID);
    expect(response.json().agent.id).toBe(AGENT_ID);
    expect(response.json()).not.toHaveProperty("warning");
    await app.close();
  });

  it("handoffMessage is optional on create", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    const { handoffMessage: _omit, ...rest } = VALID;
    expect((await create(app, { instanceId: INSTANCE_ID, ...rest })).statusCode).toBe(201);
    expect(store.createAgent).toHaveBeenCalledWith(INSTANCE_ID, rest);
    await app.close();
  });

  it("409 when the instance already has an agent; 404 when the instance is missing", async () => {
    const taken = buildApp(deps(fakeDashboardStore({ countAgents: vi.fn().mockResolvedValue(1) })));
    expect((await create(taken, { instanceId: INSTANCE_ID, ...VALID })).statusCode).toBe(409);
    await taken.close();

    const missing = buildApp(deps(fakeDashboardStore({ instanceExists: vi.fn().mockResolvedValue(false) })));
    expect((await create(missing, { instanceId: INSTANCE_ID, ...VALID })).statusCode).toBe(404);
    await missing.close();
  });

  it("400 on invalid input", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    for (const bad of [
      { instanceId: "nope", ...VALID },
      { instanceId: INSTANCE_ID, ...VALID, provider: "gemini" },
      { instanceId: INSTANCE_ID, ...VALID, name: "   " },
      { instanceId: INSTANCE_ID, ...VALID, model: "" },
      { instanceId: INSTANCE_ID, ...VALID, systemPrompt: "a".repeat(20001) },
      { instanceId: INSTANCE_ID, ...VALID, handoffMessage: "a".repeat(1001) },
      { instanceId: INSTANCE_ID, ...VALID, isActive: "yes" },
    ]) {
      expect((await create(app, bad)).statusCode).toBe(400);
    }
    expect(store.createAgent).not.toHaveBeenCalled();
    await app.close();
  });

  it("warns when the provider has no key configured", async () => {
    const app = buildApp(deps(fakeDashboardStore(), { anthropic: false, openai: true }));
    const response = await create(app, { instanceId: INSTANCE_ID, ...VALID });
    expect(response.statusCode).toBe(201);
    expect(response.json().warning).toBe("provider-key-missing");
    await app.close();
  });
});

describe("PUT /agents/:id", () => {
  const put = (app: ReturnType<typeof buildApp>, id: string, payload: object) =>
    app.inject({ method: "PUT", url: `/agents/${id}`, payload, headers: AUTH_HEADERS });

  it("200 updates and returns the agent", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    const response = await put(app, AGENT_ID, VALID);
    expect(response.statusCode).toBe(200);
    expect(store.updateAgent).toHaveBeenCalledWith(AGENT_ID, VALID);
    await app.close();
  });

  it("404 for a malformed or unknown id", async () => {
    const store = fakeDashboardStore({ updateAgent: vi.fn().mockResolvedValue(null) });
    const app = buildApp(deps(store));
    expect((await put(app, "abc", VALID)).statusCode).toBe(404);
    expect((await put(app, AGENT_ID, VALID)).statusCode).toBe(404);
    await app.close();
  });

  it("400 when handoffMessage is missing (full replace)", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    const { handoffMessage: _omit, ...rest } = VALID;
    expect((await put(app, AGENT_ID, rest)).statusCode).toBe(400);
    await app.close();
  });
});
