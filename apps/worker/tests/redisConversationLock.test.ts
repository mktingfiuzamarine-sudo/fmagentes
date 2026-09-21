import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createRedisConversationLock } from "../src/redisConversationLock";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

beforeAll(async () => {
  await redis.ping();
});

afterAll(async () => {
  await redis.quit();
});

describe("createRedisConversationLock", () => {
  it("grants the lock to one holder at a time", async () => {
    const lock = createRedisConversationLock(redis);
    const id = randomUUID();

    const first = await lock.acquire(id);
    expect(first).not.toBeNull();
    expect(await lock.acquire(id)).toBeNull();

    await first!.release();
    const third = await lock.acquire(id);
    expect(third).not.toBeNull();
    await third!.release();
  });

  it("does not block different conversations", async () => {
    const lock = createRedisConversationLock(redis);
    const a = await lock.acquire(randomUUID());
    const b = await lock.acquire(randomUUID());

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it("releases only its own hold, never a successor's", async () => {
    const id = randomUUID();
    const shortLived = createRedisConversationLock(redis, 60);

    const first = await shortLived.acquire(id);
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120)); // let the TTL expire

    const second = await shortLived.acquire(id);
    expect(second).not.toBeNull();

    // The stale holder releasing must not free the new holder's lock.
    await first!.release();
    expect(await shortLived.acquire(id)).toBeNull();

    await second!.release();
  });

  it("expires the lock on its own after the TTL", async () => {
    const id = randomUUID();
    const shortLived = createRedisConversationLock(redis, 60);

    expect(await shortLived.acquire(id)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const later = await shortLived.acquire(id);
    expect(later).not.toBeNull();
    await later!.release();
  });
});
