import { describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(() => ({ mocked: true })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { createSupabaseClient } from "../src/supabaseClient";

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
});
