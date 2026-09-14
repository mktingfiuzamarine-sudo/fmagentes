import { vi } from "vitest";
import type { AppDependencies } from "../../src/app";

export const TEST_USER = { id: "test-user", email: "dev@fmagentes.com" };

/** Accepts any bearer token as TEST_USER — route tests assert routing, not auth. */
export const testAuth = (): AppDependencies["auth"] => ({ getUser: vi.fn().mockResolvedValue(TEST_USER) });

export const TEST_ALLOWED_USERS = [TEST_USER.email];

/** Satisfies the auth preHandler on the protected routes. */
export const AUTH_HEADERS = { authorization: "Bearer test-token" };
