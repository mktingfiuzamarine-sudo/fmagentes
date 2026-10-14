import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { createRedisConversationLock, lockKey } from "../src/redisConversationLock";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // renewEveryMs: 0 simulates a holder that crashed and stopped renewing.
    const shortLived = createRedisConversationLock(redis, 60, { renewEveryMs: 0 });

    const first = await shortLived.acquire(id);
    expect(first).not.toBeNull();
    await wait(120); // let the TTL expire

    const second = await shortLived.acquire(id);
    expect(second).not.toBeNull();

    // The stale holder releasing must not free the new holder's lock.
    await first!.release();
    expect(await shortLived.acquire(id)).toBeNull();

    await second!.release();
  });

  it("expires the lock on its own when the holder stops renewing", async () => {
    const id = randomUUID();
    const shortLived = createRedisConversationLock(redis, 60, { renewEveryMs: 0 });

    expect(await shortLived.acquire(id)).not.toBeNull();
    await wait(120);
    const later = await shortLived.acquire(id);
    expect(later).not.toBeNull();
    await later!.release();
  });

  it("keeps the lock past its TTL while the holder is alive", async () => {
    const id = randomUUID();
    const lock = createRedisConversationLock(redis, 150);

    const held = await lock.acquire(id);
    expect(held).not.toBeNull();
    await wait(500); // more than three TTLs

    expect(await lock.acquire(id)).toBeNull();
    expect(held!.isLost()).toBe(false);

    await held!.release();
    const next = await lock.acquire(id);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it("reports lost when another holder took the key", async () => {
    const id = randomUUID();
    const lock = createRedisConversationLock(redis, 300);

    const held = await lock.acquire(id);
    await redis.set(lockKey(id), "someone-else", "PX", 5000);
    await wait(250); // renewal runs every 100 ms

    expect(held!.isLost()).toBe(true);
    await held!.release(); // must not delete the other holder's key
    expect(await redis.get(lockKey(id))).toBe("someone-else");
    await redis.del(lockKey(id));
  });

  it("reports lost when the key vanished", async () => {
    const id = randomUUID();
    const lock = createRedisConversationLock(redis, 300);

    const held = await lock.acquire(id);
    await redis.del(lockKey(id));
    await wait(250);

    expect(held!.isLost()).toBe(true);
    await held!.release();
  });
});
