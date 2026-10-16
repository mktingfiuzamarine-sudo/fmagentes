import { describe, expect, it, vi } from "vitest";
import type { InjectOptions } from "fastify";
import { buildApp, type AppConfig, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, testAuth } from "./helpers/auth";

function deps(config: Partial<AppConfig> = {}, checkConnection = vi.fn(async () => true)): AppDependencies {
  return {
    redis: { ping: async () => "PONG" } as never,
    supabase: {
      from: () => ({
        select: () => ({
          limit: async () => ({ error: null }),
          order: () => ({ then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) }),
        }),
      }),
    } as never,
    evolutionApi: { checkConnection } as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: testAuth(),
    config: {
      webhookSecret: "s",
      publicWebhookUrl: "https://cb.example.com",
      allowedUsers: TEST_ALLOWED_USERS,
      ...config,
    },
  };
}

async function statuses(app: ReturnType<typeof buildApp>, count: number, request: InjectOptions) {
  const codes: number[] = [];
  for (let i = 0; i < count; i++) codes.push((await app.inject(request)).statusCode);
  return codes;
}

describe("rate limiting (I4)", () => {
  it("answers 429 once an address exceeds its budget on the consumer routes", async () => {
    const app = buildApp(deps({ rateLimit: { perMinute: 3, healthPerMinute: 3 } }));

    const codes = await statuses(app, 4, { method: "GET", url: "/instances", headers: AUTH_HEADERS });

    expect(codes).toEqual([200, 200, 200, 429]);
    await app.close();
  });

  it("limits before verifying the token, so floods cannot reach Supabase Auth", async () => {
    const d = deps({ rateLimit: { perMinute: 2, healthPerMinute: 2 } });
    const getUser = vi.spyOn(d.auth, "getUser");
    const app = buildApp(d);

    await statuses(app, 5, { method: "GET", url: "/instances", headers: { authorization: "Bearer junk" } });

    expect(getUser).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("never limits the Evolution webhook, which bursts from one address", async () => {
    const app = buildApp(deps({ rateLimit: { perMinute: 1, healthPerMinute: 1 } }));

    const codes = await statuses(app, 3, {
      method: "POST",
      url: "/webhooks/evolution",
      headers: { apikey: "s" },
      payload: { event: "unknown" },
    });

    expect(codes).not.toContain(429);
    await app.close();
  });

  it("gives /health its own, tighter budget", async () => {
    const app = buildApp(deps({ rateLimit: { perMinute: 100, healthPerMinute: 2 } }));

    expect(await statuses(app, 3, { method: "GET", url: "/health" })).toEqual([200, 200, 429]);
    expect((await app.inject({ method: "GET", url: "/instances", headers: AUTH_HEADERS })).statusCode).toBe(200);
    await app.close();
  });

  it("counts each client separately behind a trusted proxy", async () => {
    const app = buildApp(deps({ rateLimit: { perMinute: 1, healthPerMinute: 1 }, trustProxy: true }));
    const from = (ip: string) => ({ method: "GET" as const, url: "/instances", headers: { ...AUTH_HEADERS, "x-forwarded-for": ip } });

    expect((await app.inject(from("203.0.113.1"))).statusCode).toBe(200);
    expect((await app.inject(from("203.0.113.2"))).statusCode).toBe(200);
    expect((await app.inject(from("203.0.113.1"))).statusCode).toBe(429);
    await app.close();
  });
});

describe("/health does not amplify traffic (I4)", () => {
  it("reuses a recent result instead of probing every dependency on each call", async () => {
    const checkConnection = vi.fn(async () => true);
    const app = buildApp(deps({}, checkConnection));

    await statuses(app, 3, { method: "GET", url: "/health" });

    expect(checkConnection).toHaveBeenCalledOnce();
    await app.close();
  });

  it("probes again once the cached result is stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const checkConnection = vi.fn(async () => true);
      const app = buildApp(deps({}, checkConnection));

      await app.inject({ method: "GET", url: "/health" });
      vi.setSystemTime(Date.now() + 60_000);
      await app.inject({ method: "GET", url: "/health" });

      expect(checkConnection).toHaveBeenCalledTimes(2);
      await app.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
