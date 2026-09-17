import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";
import { createSupabaseAuthPort } from "../src/auth";

const ALICE = { id: "user-1", email: "alice@fmagentes.com" };

function deps(over: { getUser?: ReturnType<typeof vi.fn>; allowedUsers?: string[] } = {}): AppDependencies {
  return {
    redis: { ping: async () => "PONG" } as never,
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          order: () => ({ then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) }),
          limit: async () => ({ error: null }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    } as never,
    evolutionApi: { checkConnection: async () => true } as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: { getUser: over.getUser ?? vi.fn().mockResolvedValue(ALICE) } as never,
    config: {
      webhookSecret: "s3cr3t",
      publicWebhookUrl: "https://cb.example.com",
      allowedUsers: over.allowedUsers ?? [ALICE.email],
    },
  };
}

const get = (app: ReturnType<typeof buildApp>, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers });

describe("auth preHandler on protected routes", () => {
  it("401 when the Authorization header is absent", async () => {
    const app = buildApp(deps());
    expect((await get(app, "/instances")).statusCode).toBe(401);
    await app.close();
  });

  it("401 when the Authorization header is not a Bearer token", async () => {
    const app = buildApp(deps());
    expect((await get(app, "/instances", { authorization: "Basic abc" })).statusCode).toBe(401);
    await app.close();
  });

  it("401 when the token does not resolve to a user", async () => {
    const getUser = vi.fn().mockResolvedValue(null);
    const app = buildApp(deps({ getUser }));

    const response = await get(app, "/instances", { authorization: "Bearer expired" });

    expect(response.statusCode).toBe(401);
    expect(getUser).toHaveBeenCalledWith("expired");
    await app.close();
  });

  it("401 when token verification throws", async () => {
    const app = buildApp(deps({ getUser: vi.fn().mockRejectedValue(new Error("supabase down")) }));
    expect((await get(app, "/instances", { authorization: "Bearer t" })).statusCode).toBe(401);
    await app.close();
  });

  it("403 when the user is authenticated but not on the allowlist", async () => {
    const app = buildApp(deps({ getUser: vi.fn().mockResolvedValue({ id: "u9", email: "mallory@evil.example" }) }));
    expect((await get(app, "/instances", { authorization: "Bearer t" })).statusCode).toBe(403);
    await app.close();
  });

  it("403 for everyone when the allowlist is empty (fails closed)", async () => {
    const app = buildApp(deps({ allowedUsers: [] }));
    expect((await get(app, "/instances", { authorization: "Bearer t" })).statusCode).toBe(403);
    await app.close();
  });

  it("matches the allowlist case-insensitively and ignores surrounding whitespace", async () => {
    const app = buildApp(deps({ allowedUsers: ["  ALICE@FMAGENTES.COM "] }));
    expect((await get(app, "/instances", { authorization: "Bearer t" })).statusCode).toBe(200);
    await app.close();
  });

  it("accepts the user id as an allowlist entry, not only the email", async () => {
    const app = buildApp(deps({ allowedUsers: [ALICE.id] }));
    expect((await get(app, "/instances", { authorization: "Bearer t" })).statusCode).toBe(200);
    await app.close();
  });

  it("200 for a valid, allowlisted user", async () => {
    const app = buildApp(deps());
    expect((await get(app, "/instances", { authorization: "Bearer good" })).statusCode).toBe(200);
    await app.close();
  });

  it("guards every protected route, not just the listing", async () => {
    const app = buildApp(deps());
    for (const url of ["/instances", "/instances/inst-1", "/instances/inst-1/qr"]) {
      expect((await get(app, url)).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/instances", payload: { name: "x" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/instances/inst-1" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/conversations/c1/messages", payload: { text: "oi" } })).statusCode,
    ).toBe(401);
    await app.close();
  });
});

describe("createSupabaseAuthPort", () => {
  const port = (getUser: unknown) => createSupabaseAuthPort({ auth: { getUser } } as never);

  it("maps a verified token to the authenticated user", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: "u1", email: "a@b.com" } }, error: null });

    expect(await port(getUser).getUser("tok")).toEqual({ id: "u1", email: "a@b.com" });
    expect(getUser).toHaveBeenCalledWith("tok");
  });

  it("returns null when Supabase rejects the token", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: { message: "invalid JWT" } });
    expect(await port(getUser).getUser("bad")).toBeNull();
  });

  it("returns null when no user comes back even without an error", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: null });
    expect(await port(getUser).getUser("tok")).toBeNull();
  });

  it("normalises a missing email to null rather than undefined", async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    expect(await port(getUser).getUser("tok")).toEqual({ id: "u1", email: null });
  });
});

describe("routes deliberately left outside the auth hook", () => {
  it("GET /health stays public", async () => {
    const app = buildApp(deps());
    expect((await get(app, "/health")).statusCode).toBe(200);
    await app.close();
  });

  it("POST /webhooks/evolution still authenticates with its own apikey, not a Bearer", async () => {
    const app = buildApp(deps());

    const accepted = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      headers: { apikey: "s3cr3t", "content-type": "application/json" },
      payload: { event: "contacts.update", instance: "acme", data: {} },
    });
    expect(accepted.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { event: "contacts.update", instance: "acme", data: {} },
    });
    expect(rejected.statusCode).toBe(401);

    await app.close();
  });
});
