import { describe, expect, it } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";

function fakeDeps(): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    testQueue: { add: async () => ({ id: "1" }) } as never,
  };
}

describe("POST /webhooks/evolution", () => {
  it("returns 200 for a well-formed payload", async () => {
    const app = buildApp(fakeDeps());

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: { event: "messages.upsert", data: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await app.close();
  });

  it("returns 200 even for a malformed JSON payload, to avoid webhook retries", async () => {
    const app = buildApp(fakeDeps());

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: "{not valid json",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: false });

    await app.close();
  });
});
