import { vi } from "vitest";

export type TableCall = { op: string; args: unknown[] }[];
export type TableResult = { data: unknown; error: unknown; count?: number | null };

/**
 * Chainable Supabase mock: `handlers` maps a table/view name to a function
 * that gets the recorded call chain and returns what the awaited query
 * resolves to. `getUserById` backs `auth.admin.getUserById`.
 */
export function createSupabaseMock(
  handlers: Record<string, (calls: TableCall) => TableResult>,
  options: { getUserById?: (id: string) => Promise<{ data: { user: { email?: string } | null }; error: unknown }> } = {},
) {
  return {
    from(table: string) {
      const calls: TableCall = [];
      const result = () => handlers[table]?.(calls) ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "insert", "update", "delete", "eq", "in", "order", "limit"]) {
        chain[op] = vi.fn((...args: unknown[]) => {
          calls.push({ op, args });
          return chain;
        });
      }
      chain.single = vi.fn(async () => result());
      chain.maybeSingle = vi.fn(async () => result());
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return chain;
    },
    auth: {
      admin: {
        getUserById: vi.fn(options.getUserById ?? (async () => ({ data: { user: null }, error: null }))),
      },
    },
  };
}
