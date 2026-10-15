import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, TEST_USER, testAuth } from "./helpers/auth";
import { fakeDashboardStore } from "./helpers/fakeDashboardStore";

function deps(over: Partial<AppDependencies> = {}): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: testAuth(),
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com", allowedUsers: TEST_ALLOWED_USERS },
    dashboard: fakeDashboardStore(),
    ...over,
  };
}

describe("GET /me", () => {
  it("401 without a token", async () => {
    const app = buildApp(deps());
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    await app.close();
  });

  it("returns the user, the team display name and available providers", async () => {
    const app = buildApp(
      deps({
        dashboard: fakeDashboardStore({ displayNames: vi.fn().mockResolvedValue(new Map([[TEST_USER.id, "Rafael"]])) }),
        config: {
          webhookSecret: "s",
          publicWebhookUrl: "https://cb.example.com",
          allowedUsers: TEST_ALLOWED_USERS,
          providers: { anthropic: true, openai: false },
        },
      }),
    );

    const response = await app.inject({ method: "GET", url: "/me", headers: AUTH_HEADERS });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: TEST_USER.id,
      email: TEST_USER.email,
      displayName: "Rafael",
      providers: { anthropic: true, openai: false },
    });
    await app.close();
  });

  it("falls back to the e-mail and to no providers", async () => {
    const app = buildApp(deps());
    const body = (await app.inject({ method: "GET", url: "/me", headers: AUTH_HEADERS })).json();
    expect(body.displayName).toBe(TEST_USER.email);
    expect(body.providers).toEqual({ anthropic: false, openai: false });
    await app.close();
  });
});
