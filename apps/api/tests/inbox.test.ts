import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";
import { AUTH_HEADERS, TEST_ALLOWED_USERS, TEST_USER, testAuth } from "./helpers/auth";
import { CONV_ID, fakeDashboardStore, inboxRow } from "./helpers/fakeDashboardStore";
import type { DashboardStore } from "../src/dashboard/store";

function deps(store: DashboardStore, over: Partial<AppDependencies> = {}): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    auth: testAuth(),
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com", allowedUsers: TEST_ALLOWED_USERS },
    dashboard: store,
    ...over,
  };
}

const get = (app: ReturnType<typeof buildApp>, url: string, headers = AUTH_HEADERS) =>
  app.inject({ method: "GET", url, headers });
const post = (app: ReturnType<typeof buildApp>, url: string) => app.inject({ method: "POST", url, headers: AUTH_HEADERS });

describe("GET /conversations", () => {
  it("401 without a token", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    expect((await get(app, "/conversations", {} as never)).statusCode).toBe(401);
    await app.close();
  });

  it("defaults to the handoff view and returns items with counts", async () => {
    const store = fakeDashboardStore({
      listInbox: vi.fn().mockResolvedValue([inboxRow({ assignedTo: "u9" })]),
      countInbox: vi.fn().mockResolvedValue({ handoff: 3, mine: 1 }),
      displayNames: vi.fn().mockResolvedValue(new Map([["u9", "Ana"]])),
    });
    const app = buildApp(deps(store));

    const response = await get(app, "/conversations");

    expect(response.statusCode).toBe(200);
    expect(store.listInbox).toHaveBeenCalledWith("handoff", TEST_USER.id);
    expect(response.json()).toEqual({
      items: [
        {
          id: CONV_ID,
          contactPhone: "5511900000002",
          instance: { id: expect.any(String), name: "loja" },
          status: "awaiting_human",
          handoffSummary: "Quer orçamento",
          handoffAt: "2026-10-15T12:00:00.000Z",
          assignedTo: { id: "u9", displayName: "Ana" },
          lastMessage: { direction: "in", content: "Alguém aí?", createdAt: "2026-10-15T12:00:01.000Z" },
          awaitingReply: true,
          crmLinkVia: null,
        },
      ],
      counts: { handoff: 3, mine: 1 },
    });
    await app.close();
  });

  it("awaitingReply is false when the latest message is outbound, and previews are truncated", async () => {
    const long = "x".repeat(300);
    const store = fakeDashboardStore({
      listInbox: vi.fn().mockResolvedValue([
        inboxRow({ lastMessage: { direction: "out", content: long, createdAt: "t" } }),
      ]),
    });
    const app = buildApp(deps(store));
    const item = (await get(app, "/conversations?view=all")).json().items[0];
    expect(item.awaitingReply).toBe(false);
    expect(item.lastMessage.content).toHaveLength(140);
    expect(item.lastMessage.content.endsWith("…")).toBe(true);
    expect(store.listInbox).toHaveBeenCalledWith("all", TEST_USER.id);
    await app.close();
  });

  it("truncation never splits a surrogate pair", async () => {
    const long = "x".repeat(138) + "😀" + "y".repeat(50);
    const store = fakeDashboardStore({
      listInbox: vi.fn().mockResolvedValue([inboxRow({ lastMessage: { direction: "out", content: long, createdAt: "t" } })]),
    });
    const app = buildApp(deps(store));
    const content = (await get(app, "/conversations?view=all")).json().items[0].lastMessage.content as string;
    expect(Array.from(content)).toHaveLength(140);
    expect(content.endsWith("…")).toBe(true);
    expect(/[�-�](?![�-�])/.test(content)).toBe(false);
    await app.close();
  });

  it("unknown assignee falls back to the id", async () => {
    const store = fakeDashboardStore({ listInbox: vi.fn().mockResolvedValue([inboxRow({ assignedTo: "gone" })]) });
    const app = buildApp(deps(store));
    expect((await get(app, "/conversations")).json().items[0].assignedTo).toEqual({ id: "gone", displayName: "gone" });
    await app.close();
  });

  it("400 on an unknown view", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    expect((await get(app, "/conversations?view=bogus")).statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /conversations/:id", () => {
  it("404 for a malformed id without querying", async () => {
    const store = fakeDashboardStore();
    const app = buildApp(deps(store));
    expect((await get(app, "/conversations/abc")).statusCode).toBe(404);
    expect(store.getInboxRow).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 for an unknown id", async () => {
    const app = buildApp(deps(fakeDashboardStore()));
    expect((await get(app, `/conversations/${CONV_ID}`)).statusCode).toBe(404);
    await app.close();
  });

  it("returns messages with authors and the CRM name for a phone link", async () => {
    const store = fakeDashboardStore({
      getInboxRow: vi.fn().mockResolvedValue(inboxRow({ crmClientId: "crm-1", crmLinkVia: "phone" })),
      listMessages: vi.fn().mockResolvedValue([
        { id: "m1", direction: "in", role: "user", content: "oi", createdAt: "1", sentBy: null },
        { id: "m2", direction: "out", role: "assistant", content: "olá", createdAt: "2", sentBy: "u9" },
      ]),
      displayNames: vi.fn().mockResolvedValue(new Map([["u9", "Ana"]])),
    });
    const customerNames = { findName: vi.fn().mockResolvedValue("Carla Mendes") };
    const app = buildApp(deps(store, { customerNames }));

    const body = (await get(app, `/conversations/${CONV_ID}`)).json();

    expect(store.listMessages).toHaveBeenCalledWith(CONV_ID, 100);
    expect(body.messages[0].sentBy).toBeNull();
    expect(body.messages[1].sentBy).toEqual({ id: "u9", displayName: "Ana" });
    expect(body.customer).toEqual({ linkVia: "phone", name: "Carla Mendes" });
    await app.close();
  });

  it("never sends the name of a CPF-linked customer", async () => {
    const store = fakeDashboardStore({
      getInboxRow: vi.fn().mockResolvedValue(inboxRow({ crmClientId: "crm-1", crmLinkVia: "cpf" })),
    });
    const customerNames = { findName: vi.fn().mockResolvedValue("Dono do CPF") };
    const app = buildApp(deps(store, { customerNames }));

    const body = (await get(app, `/conversations/${CONV_ID}`)).json();

    expect(body.customer).toEqual({ linkVia: "cpf", unverified: true });
    expect(customerNames.findName).not.toHaveBeenCalled();
    await app.close();
  });

  it("CRM failure or absence still answers 200 with name null", async () => {
    const store = fakeDashboardStore({
      getInboxRow: vi.fn().mockResolvedValue(inboxRow({ crmClientId: "crm-1", crmLinkVia: "created" })),
    });
    const failing = { findName: vi.fn().mockRejectedValue(new Error("CRM down")) };

    const withFailing = buildApp(deps(store, { customerNames: failing }));
    const r1 = await get(withFailing, `/conversations/${CONV_ID}`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().customer).toEqual({ linkVia: "created", name: null });
    await withFailing.close();

    const withoutCrm = buildApp(deps(store));
    expect((await get(withoutCrm, `/conversations/${CONV_ID}`)).json().customer).toEqual({ linkVia: "created", name: null });
    await withoutCrm.close();
  });

  it("no CRM link → linkVia null", async () => {
    const store = fakeDashboardStore({ getInboxRow: vi.fn().mockResolvedValue(inboxRow()) });
    const app = buildApp(deps(store));
    expect((await get(app, `/conversations/${CONV_ID}`)).json().customer).toEqual({ linkVia: null });
    await app.close();
  });
});

describe("assign / unassign", () => {
  it("assigns to the caller", async () => {
    const store = fakeDashboardStore({ displayNames: vi.fn().mockResolvedValue(new Map([[TEST_USER.id, "Rafael"]])) });
    const app = buildApp(deps(store));
    const response = await post(app, `/conversations/${CONV_ID}/assign`);
    expect(response.statusCode).toBe(200);
    expect(store.assign).toHaveBeenCalledWith(CONV_ID, TEST_USER.id);
    expect(response.json()).toEqual({ assignedTo: { id: TEST_USER.id, displayName: "Rafael" } });
    await app.close();
  });

  it("409 when not awaiting a human, 404 when missing or malformed", async () => {
    const notAwaiting = buildApp(deps(fakeDashboardStore({ assign: vi.fn().mockResolvedValue("not-awaiting") })));
    expect((await post(notAwaiting, `/conversations/${CONV_ID}/assign`)).statusCode).toBe(409);
    await notAwaiting.close();

    const missing = buildApp(deps(fakeDashboardStore({ assign: vi.fn().mockResolvedValue("not-found") })));
    expect((await post(missing, `/conversations/${CONV_ID}/assign`)).statusCode).toBe(404);
    expect((await post(missing, "/conversations/nope/assign")).statusCode).toBe(404);
    await missing.close();
  });

  it("unassigns; 404 when missing", async () => {
    const ok = buildApp(deps(fakeDashboardStore()));
    const response = await post(ok, `/conversations/${CONV_ID}/unassign`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ assignedTo: null });
    await ok.close();

    const missing = buildApp(deps(fakeDashboardStore({ unassign: vi.fn().mockResolvedValue(false) })));
    expect((await post(missing, `/conversations/${CONV_ID}/unassign`)).statusCode).toBe(404);
    await missing.close();
  });
});
