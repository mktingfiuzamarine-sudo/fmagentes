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

/** Extends the TTL only while the key still holds our nonce. */
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Sized for the Evolution call, which has hung in production before. The
 * heartbeat keeps a live holder's lock past it; the TTL only bounds how long
 * a crashed holder blocks the conversation.
 */
export const DEFAULT_LOCK_TTL_MS = 30_000;

/**
 * Longest a holder may keep renewing. A healthy job ends well before this (LLM
 * 45 s, each request at most 10 s plus postgrest's read retries); past it the
 * holder is presumed hung, stops renewing and must not send (isLost), and the
 * key expires one TTL later so the conversation's next job can run.
 */
export const DEFAULT_MAX_HOLD_MS = 180_000;

export interface RedisLockOptions {
  /** Defaults to a third of the TTL. 0 disables renewal (tests: a crashed holder). */
  renewEveryMs?: number;
  /** Defaults to DEFAULT_MAX_HOLD_MS. */
  maxHoldMs?: number;
}

export function lockKey(conversationId: string): string {
  return `lock:conv:${conversationId}`;
}

export function createRedisConversationLock(
  redis: Redis,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
  options: RedisLockOptions = {},
): ConversationLock {
  const renewEveryMs = options.renewEveryMs ?? Math.floor(ttlMs / 3);
  const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;

  return {
    async acquire(conversationId: string) {
      const key = lockKey(conversationId);
      const nonce = randomUUID();

      const acquired = await redis.set(key, nonce, "PX", ttlMs, "NX");
      if (acquired !== "OK") return null;

      let lost = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const markLost = () => {
        lost = true;
        if (timer) clearInterval(timer);
      };

      if (renewEveryMs > 0) {
        const acquiredAt = Date.now();
        timer = setInterval(() => {
          if (Date.now() - acquiredAt >= maxHoldMs) return markLost();
          // A Redis error counts as lost too: we can no longer prove we hold it.
          redis.eval(RENEW_SCRIPT, 1, key, nonce, String(ttlMs)).then(
            (renewed) => {
              if (renewed !== 1) markLost();
            },
            markLost,
          );
        }, renewEveryMs);
        timer.unref();
      }

      return {
        isLost: () => lost,
        async release() {
          if (timer) clearInterval(timer);
          await redis.eval(RELEASE_SCRIPT, 1, key, nonce);
        },
      };
    },
  };
}
