import { vi } from "vitest";

/**
 * Minimal chainable Supabase mock. `handlers` maps a table name to a function
 * that receives the recorded call chain and returns the `{ data, error }` the
 * final awaited call should resolve to.
 */
export type TableCall = { op: string; args: unknown[] }[];

export function createSupabaseMock(handlers: Record<string, (calls: TableCall) => { data: unknown; error: unknown }>) {
  return {
    from(table: string) {
      const calls: TableCall = [];
      const result = () => handlers[table]?.(calls) ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "insert", "upsert", "update", "delete", "eq", "order", "limit"]) {
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
  };
}
