import { vi } from "vitest";

export type TableCall = { op: string; args: unknown[] }[];
export type Handler = (calls: TableCall) => { data: unknown; error: unknown };

/** Chainable Supabase mock; each `from()` records its call chain for the handler. */
export function createSupabaseMock(handlers: Record<string, Handler>) {
  const from = vi.fn((table: string) => {
    const calls: TableCall = [];
    const result = () => handlers[table]?.(calls) ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const op of ["select", "insert", "update", "eq", "is", "or", "limit"]) {
      chain[op] = vi.fn((...args: unknown[]) => {
        calls.push({ op, args });
        return chain;
      });
    }
    chain.single = vi.fn(async () => result());
    chain.maybeSingle = vi.fn(async () => result());
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
    return chain;
  });
  return { from };
}
