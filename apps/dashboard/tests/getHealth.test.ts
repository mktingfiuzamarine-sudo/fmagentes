import { afterEach, describe, expect, it, vi } from "vitest";
import { getHealth } from "../lib/getHealth";

describe("getHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed health status on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ supabase: "connected", redis: "connected", evolutionApi: "connected" }),
      })
    );

    const result = await getHealth("http://localhost:3001");

    expect(result).toEqual({ supabase: "connected", redis: "connected", evolutionApi: "connected" });
    expect(fetch).toHaveBeenCalledWith("http://localhost:3001/health", { cache: "no-store" });
  });

  it("returns null when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await getHealth("http://localhost:3001");

    expect(result).toBeNull();
  });
});
