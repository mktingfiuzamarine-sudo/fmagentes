import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { ingestMock } = vi.hoisted(() => ({ ingestMock: vi.fn() }));

vi.mock("@fmagentes/messaging", async (importActual) => ({
  ...(await importActual<typeof import("@fmagentes/messaging")>()),
  ingestInboundMessage: ingestMock,
}));

import { buildApp, type AppDependencies } from "../src/app";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8"));

function deps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    redis: {} as never,
    supabase: { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) } as never,
    evolutionApi: { fetchInstance: async () => ({ state: "open", number: "5511988887777" }) } as never,
    inboundQueue: { add: vi.fn().mockResolvedValue({ id: "job-1" }) } as never,
    config: { webhookSecret: "s3cr3t", publicWebhookUrl: "https://cb.example.com" },
    ...overrides,
  };
}

const post = (app: ReturnType<typeof buildApp>, payload: string | object, apikey = "s3cr3t") =>
  app.inject({
    method: "POST",
    url: "/webhooks/evolution",
    headers: { apikey, "content-type": "application/json" },
    payload,
  });

beforeEach(() => ingestMock.mockReset());

describe("POST /webhooks/evolution", () => {
  it("401 when the apikey header is missing or wrong", async () => {
    const app = buildApp(deps());
    expect((await post(app, {}, "nope")).statusCode).toBe(401);
    await app.close();
  });

  it("200 and enqueues a job for a new inbound text message", async () => {
    ingestMock.mockResolvedValue({ messageId: "m1", conversationId: "c1", instanceId: "i1" });
    const d = deps();
    const app = buildApp(d);

    const response = await post(app, fixture("messages-upsert"));

    expect(response.statusCode).toBe(200);
    expect((d.inboundQueue as never as { add: ReturnType<typeof vi.fn> }).add).toHaveBeenCalledWith(
      "inbound-messages",
      { messageId: "m1", conversationId: "c1", instanceId: "i1" },
    );
    await app.close();
  });

  it("200 and does NOT enqueue when ingest returns null (duplicate / unknown instance)", async () => {
    ingestMock.mockResolvedValue(null);
    const d = deps();
    const app = buildApp(d);

    const response = await post(app, fixture("messages-upsert"));

    expect(response.statusCode).toBe(200);
    expect((d.inboundQueue as never as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();
    await app.close();
  });

  it("200 and ignores a fromMe message without calling ingest or the queue", async () => {
    const d = deps();
    const app = buildApp(d);
    const payload = fixture("messages-upsert");
    payload.data.key.fromMe = true;

    expect((await post(app, payload)).statusCode).toBe(200);
    expect(ingestMock).not.toHaveBeenCalled();
    expect((d.inboundQueue as never as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();
    await app.close();
  });

  it("200 for an unknown event type", async () => {
    const app = buildApp(deps());
    expect((await post(app, { event: "contacts.update", instance: "acme", data: {} })).statusCode).toBe(200);
    await app.close();
  });

  it("200 for an unparseable payload", async () => {
    const app = buildApp(deps());
    expect((await post(app, "{not json", "s3cr3t")).statusCode).toBe(200);
    await app.close();
  });

  it("updates instance status on connection.update", async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const d = deps({ supabase: { from: () => ({ update }) } as never });
    const app = buildApp(d);

    const response = await post(app, fixture("connection-update"));

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "connected", phone_number: "5511988887777" }));
    await app.close();
  });

  it("still writes the status on connection.update when fetchInstance fails", async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const d = deps({
      supabase: { from: () => ({ update }) } as never,
      evolutionApi: {
        fetchInstance: async () => {
          throw new Error("Evolution API request failed: 404 Not Found");
        },
      } as never,
    });
    const app = buildApp(d);

    const response = await post(app, fixture("connection-update"));

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({ status: "connected" });
    await app.close();
  });

  it("500 when ingest throws (transient failure → Evolution retries)", async () => {
    ingestMock.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    const app = buildApp(deps());

    expect((await post(app, fixture("messages-upsert"))).statusCode).toBe(500);
    await app.close();
  });
});
