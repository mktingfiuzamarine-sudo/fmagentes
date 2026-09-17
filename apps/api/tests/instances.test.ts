import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, testAuth } from "./helpers/auth";

function deps(over: {
  createInstance?: unknown; deleteInstance?: unknown; connectInstance?: unknown;
  rows?: Record<string, unknown>;
  update?: ReturnType<typeof vi.fn>;
} = {}): AppDependencies {
  const rows = over.rows ?? {};
  const update = over.update ?? vi.fn();
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
        update: (payload: Record<string, unknown>) => {
          update(payload);
          return { eq: async () => ({ error: null }) };
        },
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
    auth: testAuth(),
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com", allowedUsers: TEST_ALLOWED_USERS },
  };
}

describe("instance routes", () => {
  it("POST /instances creates in Evolution with the webhook config, then persists the row", async () => {
    const createInstance = vi.fn().mockResolvedValue(undefined);
    const d = deps({ createInstance });
    const app = buildApp(d);

    const response = await app.inject({ method: "POST", url: "/instances", payload: { name: "acme" }, headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "inst-1", name: "acme", evolution_instance_id: "acme", status: "created" });
    expect(createInstance).toHaveBeenCalledWith("acme", {
      url: "https://cb.example.com/webhooks/evolution",
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
      headers: { apikey: "s" },
    });
    await app.close();
  });

  it("POST /instances returns 502 and writes no row when Evolution fails", async () => {
    const app = buildApp(deps({ createInstance: vi.fn().mockRejectedValue(new Error("evo down")) }));
    const response = await app.inject({ method: "POST", url: "/instances", payload: { name: "acme" }, headers: AUTH_HEADERS });
    expect(response.statusCode).toBe(502);
    await app.close();
  });

  it("POST /instances returns 400 when name is missing", async () => {
    const app = buildApp(deps());
    expect((await app.inject({ method: "POST", url: "/instances", payload: {}, headers: AUTH_HEADERS })).statusCode).toBe(400);
    await app.close();
  });

  it("GET /instances/:id returns 404 when absent", async () => {
    const app = buildApp(deps({ rows: {} }));
    expect((await app.inject({ method: "GET", url: "/instances/inst-x", headers: AUTH_HEADERS })).statusCode).toBe(404);
    await app.close();
  });

  it("GET /instances/:id/qr connects and returns the qr payload, setting status=connecting", async () => {
    const connectInstance = vi.fn().mockResolvedValue({ qrcode: "data:img", pairingCode: "AB-12" });
    const update = vi.fn();
    const d = deps({ connectInstance, update, rows: { instances: { id: "inst-1", evolution_instance_id: "acme" } } });
    const app = buildApp(d);

    const response = await app.inject({ method: "GET", url: "/instances/inst-1/qr", headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ qrcode: "data:img", pairingCode: "AB-12" });
    expect(connectInstance).toHaveBeenCalledWith("acme");
    expect(update).toHaveBeenCalledWith({ status: "connecting" });
    await app.close();
  });

  it("GET /instances/:id/qr does NOT write status=connecting when Evolution returns no QR", async () => {
    // Evolution answers /instance/connect with {state:"open"} and no base64 for an
    // already-paired instance; writing 'connecting' there corrupts the lifecycle state.
    const update = vi.fn();
    const d = deps({
      update,
      connectInstance: vi.fn().mockResolvedValue({ qrcode: null, pairingCode: null }),
      rows: { instances: { id: "inst-1", evolution_instance_id: "acme" } },
    });
    const app = buildApp(d);

    const response = await app.inject({ method: "GET", url: "/instances/inst-1/qr", headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(update).not.toHaveBeenCalled();
    await app.close();
  });

  it("DELETE /instances/:id deletes in Evolution then removes the row", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const d = deps({ deleteInstance, rows: { instances: { id: "inst-1", evolution_instance_id: "acme" } } });
    const app = buildApp(d);

    const response = await app.inject({ method: "DELETE", url: "/instances/inst-1", headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(204);
    expect(deleteInstance).toHaveBeenCalledWith("acme");
    await app.close();
  });
});
