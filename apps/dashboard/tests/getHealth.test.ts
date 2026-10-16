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
        status: 200,
        json: async () => ({ supabase: "connected", redis: "connected", evolutionApi: "connected" }),
      })
    );

    const result = await getHealth("http://localhost:3001");

    expect(result).toEqual({ supabase: "connected", redis: "connected", evolutionApi: "connected" });
    expect(fetch).toHaveBeenCalledWith("http://localhost:3001/health", { cache: "no-store", signal: expect.any(AbortSignal) });
  });

  it("returns null when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await getHealth("http://localhost:3001");

    expect(result).toBeNull();
  });

  it("returns null without fetching when the API URL is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getHealth(undefined);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getHealth does not hang or misread (M16)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives up when the API does not answer in time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
      ),
    );

    await expect(getHealth("http://localhost:3001", 20)).resolves.toBeNull();
  });

  it("reads a 503 (a dependency down) but not a rate-limit answer", async () => {
    const body = { supabase: "unavailable", redis: "connected", evolutionApi: "connected" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503, json: async () => body }));
    await expect(getHealth("http://localhost:3001")).resolves.toEqual(body);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 429, json: async () => ({ error: "Too Many Requests" }) }));
    await expect(getHealth("http://localhost:3001")).resolves.toBeNull();
  });
});
