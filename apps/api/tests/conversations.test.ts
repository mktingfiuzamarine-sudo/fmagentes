import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, ConversationNotFoundError } = vi.hoisted(() => {
  class ConversationNotFoundError extends Error {
    constructor(public readonly conversationId: string) {
      super("not found");
      this.name = "ConversationNotFoundError";
    }
  }
  return { sendMock: vi.fn(), ConversationNotFoundError };
});

vi.mock("@fmagentes/messaging", async (importActual) => ({
  ...(await importActual<typeof import("@fmagentes/messaging")>()),
  sendMessage: sendMock,
  ConversationNotFoundError,
}));

import { buildApp, type AppDependencies } from "../src/app";

function baseDeps(): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com" },
  };
}

const send = (app: ReturnType<typeof buildApp>, payload: string | object, id = "c1") =>
  app.inject({ method: "POST", url: `/conversations/${id}/messages`, payload });

beforeEach(() => sendMock.mockReset());

describe("POST /conversations/:id/messages", () => {
  it("201 with the sent row on success", async () => {
    sendMock.mockResolvedValue({ id: "m1", conversationId: "c1", direction: "out", content: "hi", createdAt: "2026-09-02T00:00:00Z" });
    const app = buildApp(baseDeps());

    const response = await send(app, { text: "hi" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "m1", direction: "out", content: "hi" });
    await app.close();
  });

  it("400 when text is missing or empty", async () => {
    const app = buildApp(baseDeps());
    expect((await send(app, {})).statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 when the conversation does not exist", async () => {
    sendMock.mockImplementationOnce(async () => {
      throw new ConversationNotFoundError("c1");
    });
    const app = buildApp(baseDeps());
    expect((await send(app, { text: "hi" })).statusCode).toBe(404);
    await app.close();
  });

  it("502 when Evolution send fails", async () => {
    sendMock.mockImplementationOnce(async () => {
      throw new Error("evolution 500");
    });
    const app = buildApp(baseDeps());
    expect((await send(app, { text: "hi" })).statusCode).toBe(502);
    await app.close();
  });
});
