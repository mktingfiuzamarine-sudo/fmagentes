import { describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(() => ({ mocked: true })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { createSupabaseClient, fetchWithTimeout } from "../src/supabaseClient";

describe("createSupabaseClient", () => {
  it("creates a client with the given url and service key, without session persistence", () => {
    const client = createSupabaseClient({ url: "https://example.supabase.co", serviceKey: "secret" });

    expect(createClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "secret",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    expect(client).toEqual({ mocked: true });
  });

  it("adds a timing-out fetch when timeoutMs is given", () => {
    createSupabaseClient({ url: "https://crm.supabase.co", serviceKey: "secret", timeoutMs: 10_000 });

    expect(createClientMock).toHaveBeenLastCalledWith("https://crm.supabase.co", "secret", {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: expect.any(Function) },
    });
  });
});

describe("fetchWithTimeout", () => {
  // Resolves only when the signal it was given aborts, like a hung request.
  const hangingFetch = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );

  it("aborts a request that takes longer than the timeout", async () => {
    const timedFetch = fetchWithTimeout(20, hangingFetch as never);
    await expect(timedFetch("https://crm.supabase.co/rest/v1/clients")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("still honours the caller's own signal", async () => {
    const controller = new AbortController();
    const timedFetch = fetchWithTimeout(60_000, hangingFetch as never);
    const pending = timedFetch("https://crm.supabase.co/rest/v1/clients", { signal: controller.signal, method: "GET" });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(hangingFetch).toHaveBeenLastCalledWith(
      "https://crm.supabase.co/rest/v1/clients",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
