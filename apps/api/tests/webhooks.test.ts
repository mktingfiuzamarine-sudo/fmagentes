import { describe, expect, it } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";

function fakeDeps(): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: async () => ({ id: "1" }) } as never,
    config: { webhookSecret: "test-secret", publicWebhookUrl: "https://cb.example.com" },
  };
}

describe("POST /webhooks/evolution", () => {
  it("returns 200 for a well-formed payload", async () => {
    const app = buildApp(fakeDeps());

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      headers: { apikey: "test-secret" },
      payload: { event: "messages.upsert", data: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await app.close();
  });

  it("rejects a request whose apikey header does not match the webhook secret", async () => {
    const app = buildApp(fakeDeps());
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      headers: { apikey: "wrong" },
      payload: { event: "messages.upsert", instance: "x", data: {} },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
