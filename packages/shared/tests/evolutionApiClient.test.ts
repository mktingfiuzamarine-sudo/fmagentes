import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionApiClient } from "../src/evolutionApiClient";

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body };
}

const client = () => createEvolutionApiClient({ baseUrl: "https://evo.example.com", apiKey: "key" });

describe("createEvolutionApiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checkConnection returns true on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson([])));
    await expect(client().checkConnection()).resolves.toBe(true);
  });

  it("checkConnection returns false on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }));
    await expect(client().checkConnection()).resolves.toBe(false);
  });

  it("sendText posts number+text and returns the message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ key: { id: "MSG123" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().sendText("inst 1", "5511999999999", "hi");

    expect(result).toEqual({ messageId: "MSG123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://evo.example.com/message/sendText/inst%201",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ number: "5511999999999", text: "hi" }) })
    );
  });

  it("sendText returns null id when the response has none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({})));
    await expect(client().sendText("i", "5", "t")).resolves.toEqual({ messageId: null });
  });

  it("createInstance posts the name, integration and webhook config", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({}));
    vi.stubGlobal("fetch", fetchMock);

    await client().createInstance("acme", { url: "https://cb.example.com/webhooks/evolution", events: ["MESSAGES_UPSERT"] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://evo.example.com/instance/create");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.instanceName).toBe("acme");
    expect(body.integration).toBe("WHATSAPP-BAILEYS");
    expect(body.webhook.url).toBe("https://cb.example.com/webhooks/evolution");
    expect(body.webhook.events).toEqual(["MESSAGES_UPSERT"]);
  });

  it("connectInstance returns the qrcode and pairing code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ base64: "data:image/png;base64,AAAA", pairingCode: "ABCD-1234" })));
    await expect(client().connectInstance("acme")).resolves.toEqual({
      qrcode: "data:image/png;base64,AAAA",
      pairingCode: "ABCD-1234",
    });
  });

  it("deleteInstance treats a 404 as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));
    await expect(client().deleteInstance("gone")).resolves.toBeUndefined();
  });

  it("deleteInstance throws on other errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }));
    await expect(client().deleteInstance("x")).rejects.toThrow();
  });

  it("fetchInstance returns state and parsed number, or null when absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson([
      { name: "acme", connectionStatus: "open", ownerJid: "5511988887777@s.whatsapp.net" },
    ])));
    await expect(client().fetchInstance("acme")).resolves.toEqual({ state: "open", number: "5511988887777" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson([])));
    await expect(client().fetchInstance("acme")).resolves.toBeNull();
  });
});
