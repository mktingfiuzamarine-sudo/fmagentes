import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionApiClient } from "../src/evolutionApiClient";

describe("createEvolutionApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checkConnection returns true when the request succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" }));
    const client = createEvolutionApiClient({ baseUrl: "https://evo.example.com", apiKey: "key" });

    await expect(client.checkConnection()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://evo.example.com/instance/fetchInstances",
      expect.objectContaining({ headers: expect.objectContaining({ apikey: "key" }) })
    );
  });

  it("checkConnection returns false when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }));
    const client = createEvolutionApiClient({ baseUrl: "https://evo.example.com", apiKey: "key" });

    await expect(client.checkConnection()).resolves.toBe(false);
  });

  it("sendMessage posts the number and text to the send endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);
    const client = createEvolutionApiClient({ baseUrl: "https://evo.example.com", apiKey: "key" });

    await client.sendMessage("instance-1", "5511999999999", "hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://evo.example.com/message/sendText/instance-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ number: "5511999999999", text: "hello" }),
      })
    );
  });
});
