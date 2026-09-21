import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { ConversationLock } from "@fmagentes/messaging";

/**
 * Deletes the key only when it still holds our nonce. Without this check a
 * holder whose TTL expired would release the *next* holder's lock.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/** Sized for the Evolution call, which has hung in production before. */
export const DEFAULT_LOCK_TTL_MS = 30_000;

export function createRedisConversationLock(
  redis: Redis,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
): ConversationLock {
  return {
    async acquire(conversationId: string) {
      const key = `lock:conv:${conversationId}`;
      const nonce = randomUUID();

      const acquired = await redis.set(key, nonce, "PX", ttlMs, "NX");
      if (acquired !== "OK") return null;

      return {
        async release() {
          await redis.eval(RELEASE_SCRIPT, 1, key, nonce);
        },
      };
    },
  };
}
