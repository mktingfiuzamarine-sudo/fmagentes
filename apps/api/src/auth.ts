import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppDependencies } from "./app";

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

/**
 * Verifies an access token. Injected so route tests need no network.
 */
export interface AuthPort {
  getUser(token: string): Promise<AuthenticatedUser | null>;
}

/**
 * The production `AuthPort`: asks Supabase to verify the dashboard's access
 * token. Give it an anon-key client — the service-key client would ignore the
 * token and answer for the service role instead.
 */
export function createSupabaseAuthPort(client: SupabaseClient): AuthPort {
  return {
    async getUser(token: string) {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data?.user) {
        return null;
      }
      return { id: data.user.id, email: data.user.email ?? null };
    },
  };
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const BEARER = /^Bearer (.+)$/i;

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Guards the consumer-facing routes. Two distinct outcomes on purpose:
 * 401 means "we do not know who you are", 403 means "we know, and you are
 * not allowed" — the allowlist stands in for tenant scoping until the
 * schema grows an owner column.
 */
export function createAuthPreHandler(deps: AppDependencies): preHandlerHookHandler {
  const allowed = new Set(deps.config.allowedUsers.map(normalise).filter((entry) => entry.length > 0));

  return async function authPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const match = BEARER.exec(request.headers.authorization ?? "");
    if (!match) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    let user: AuthenticatedUser | null;
    try {
      user = await deps.auth.getUser(match[1]);
    } catch (error) {
      // A verification outage must not become an open door.
      request.log.warn({ err: error }, "Access token verification failed");
      return reply.code(401).send({ error: "unauthorized" });
    }

    if (!user) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const identifiers = [user.id, user.email].filter((value): value is string => Boolean(value)).map(normalise);
    if (!identifiers.some((identifier) => allowed.has(identifier))) {
      request.log.warn({ userId: user.id }, "Authenticated user is not on the allowlist");
      return reply.code(403).send({ error: "forbidden" });
    }

    request.user = user;
  };
}
