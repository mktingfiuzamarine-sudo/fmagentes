import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, resumeMock, ConversationNotFoundError } = vi.hoisted(() => {
  class ConversationNotFoundError extends Error {
    constructor(public readonly conversationId: string) {
      super("not found");
      this.name = "ConversationNotFoundError";
    }
  }
  return { sendMock: vi.fn(), resumeMock: vi.fn(), ConversationNotFoundError };
});

vi.mock("@fmagentes/messaging", async (importActual) => ({
  ...(await importActual<typeof import("@fmagentes/messaging")>()),
  sendMessage: sendMock,
  resumeConversation: resumeMock,
  ConversationNotFoundError,
}));

import { buildApp, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, testAuth } from "./helpers/auth";

function baseDeps(): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: testAuth(),
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com", allowedUsers: TEST_ALLOWED_USERS },
  };
}

const send = (app: ReturnType<typeof buildApp>, payload: string | object, id = "c1") =>
  app.inject({ method: "POST", url: `/conversations/${id}/messages`, payload, headers: AUTH_HEADERS });

beforeEach(() => {
  sendMock.mockReset();
  resumeMock.mockReset();
});

describe("POST /conversations/:id/messages", () => {
  it("records the caller as the sender", async () => {
    sendMock.mockResolvedValue({ id: "m1", conversationId: "c1", direction: "out", content: "hi", createdAt: "x" });
    const app = buildApp(baseDeps());
    await send(app, { text: "hi" });
    expect(sendMock).toHaveBeenCalledWith(expect.anything(), { conversationId: "c1", text: "hi", sentBy: "test-user" });
    await app.close();
  });

  it("400 for whitespace-only or over-4096-character text", async () => {
    const app = buildApp(baseDeps());
    expect((await send(app, { text: "   " })).statusCode).toBe(400);
    expect((await send(app, { text: "a".repeat(4097) })).statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });
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

describe("POST /conversations/:id/resume", () => {
  const ID = "6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b";
  const resume = (app: ReturnType<typeof buildApp>, headers: Record<string, string> = AUTH_HEADERS) =>
    app.inject({ method: "POST", url: `/conversations/${ID}/resume`, headers });

  it("401 without a bearer token", async () => {
    const app = buildApp(baseDeps());
    expect((await resume(app, {})).statusCode).toBe(401);
    expect(resumeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("200 and the conversation is open again", async () => {
    resumeMock.mockResolvedValue(undefined);
    const app = buildApp(baseDeps());

    const response = await resume(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: ID, status: "open" });
    expect(resumeMock).toHaveBeenCalledWith(expect.anything(), ID);
    await app.close();
  });

  it("404 when the conversation does not exist", async () => {
    resumeMock.mockImplementationOnce(async () => {
      throw new ConversationNotFoundError(ID);
    });
    const app = buildApp(baseDeps());
    expect((await resume(app)).statusCode).toBe(404);
    await app.close();
  });
});
