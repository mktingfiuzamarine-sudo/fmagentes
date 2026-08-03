import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { buildApp, type AppDependencies } from "../src/app";
import type { FastifyInstance } from "fastify";

describe("GET /health", () => {
  let app: FastifyInstance;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null, connectTimeout: 5000, retryStrategy: (times) => Math.min(times * 50, 2000) });

    // Wait for redis connection with timeout
    await Promise.race([
      new Promise((resolve) => redis.on("ready", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Redis connection timeout")), 10000)),
    ]);

    const deps: AppDependencies = {
      redis,
      supabase: { from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }) } as never,
      evolutionApi: {
        checkConnection: async () => true,
        getInstanceStatus: async () => ({ instanceName: "", state: "" }),
        sendMessage: async () => {},
      },
      testQueue: { add: async () => ({ id: "1" }) } as never,
    };

    app = buildApp(deps);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (redis) {
      await redis.quit();
    }
  });

  it("returns 200 and connected status for all services when everything is healthy", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      supabase: "connected",
      redis: "connected",
      evolutionApi: "connected",
    });
  });

  it("returns 503 when a dependency is unavailable", async () => {
    const deps: AppDependencies = {
      redis,
      supabase: { from: () => ({ select: () => ({ limit: async () => ({ error: new Error("down") }) }) }) } as never,
      evolutionApi: {
        checkConnection: async () => true,
        getInstanceStatus: async () => ({ instanceName: "", state: "" }),
        sendMessage: async () => {},
      },
      testQueue: { add: async () => ({ id: "1" }) } as never,
    };
    const unhealthyApp = buildApp(deps);

    const response = await unhealthyApp.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json().supabase).toBe("unavailable");

    await unhealthyApp.close();
  });
});
