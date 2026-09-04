import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";

function deps(over: {
  createInstance?: unknown; deleteInstance?: unknown; connectInstance?: unknown;
  rows?: Record<string, unknown>;
} = {}): AppDependencies {
  const rows = over.rows ?? {};
  return {
    redis: {} as never,
    supabase: {
      from: (table: string) => ({
        insert: (payload: Record<string, unknown>) => ({
          select: () => ({ single: async () => ({ data: { id: "inst-1", ...payload }, error: null }) }),
        }),
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }),
          order: () => ({ then: (r: (v: unknown) => unknown) => r({ data: [rows[table] ?? {}], error: null }) }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      }),
    } as never,
    evolutionApi: {
      createInstance: over.createInstance ?? vi.fn().mockResolvedValue(undefined),
      connectInstance: over.connectInstance ?? vi.fn().mockResolvedValue({ qrcode: "data:img", pairingCode: "AB-12" }),
      deleteInstance: over.deleteInstance ?? vi.fn().mockResolvedValue(undefined),
      fetchInstance: vi.fn(),
      sendText: vi.fn(),
      checkConnection: vi.fn(),
    } as never,
    inboundQueue: { add: vi.fn() } as never,
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com" },
  };
}

describe("instance routes", () => {
  it("POST /instances creates in Evolution with the webhook config, then persists the row", async () => {
    const createInstance = vi.fn().mockResolvedValue(undefined);
    const d = deps({ createInstance });
    const app = buildApp(d);

    const response = await app.inject({ method: "POST", url: "/instances", payload: { name: "acme" } });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "inst-1", name: "acme", evolution_instance_id: "acme", status: "created" });
    expect(createInstance).toHaveBeenCalledWith("acme", {
      url: "https://cb.example.com/webhooks/evolution",
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    });
    await app.close();
  });

  it("POST /instances returns 502 and writes no row when Evolution fails", async () => {
    const app = buildApp(deps({ createInstance: vi.fn().mockRejectedValue(new Error("evo down")) }));
    const response = await app.inject({ method: "POST", url: "/instances", payload: { name: "acme" } });
    expect(response.statusCode).toBe(502);
    await app.close();
  });

  it("POST /instances returns 400 when name is missing", async () => {
    const app = buildApp(deps());
    expect((await app.inject({ method: "POST", url: "/instances", payload: {} })).statusCode).toBe(400);
    await app.close();
  });

  it("GET /instances/:id returns 404 when absent", async () => {
    const app = buildApp(deps({ rows: {} }));
    expect((await app.inject({ method: "GET", url: "/instances/inst-x" })).statusCode).toBe(404);
    await app.close();
  });

  it("GET /instances/:id/qr connects and returns the qr payload, setting status=connecting", async () => {
    const connectInstance = vi.fn().mockResolvedValue({ qrcode: "data:img", pairingCode: "AB-12" });
    const d = deps({ connectInstance, rows: { instances: { id: "inst-1", evolution_instance_id: "acme" } } });
    const app = buildApp(d);

    const response = await app.inject({ method: "GET", url: "/instances/inst-1/qr" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ qrcode: "data:img", pairingCode: "AB-12" });
    expect(connectInstance).toHaveBeenCalledWith("acme");
    await app.close();
  });

  it("DELETE /instances/:id deletes in Evolution then removes the row", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const d = deps({ deleteInstance, rows: { instances: { id: "inst-1", evolution_instance_id: "acme" } } });
    const app = buildApp(d);

    const response = await app.inject({ method: "DELETE", url: "/instances/inst-1" });

    expect(response.statusCode).toBe(204);
    expect(deleteInstance).toHaveBeenCalledWith("acme");
    await app.close();
  });
});
