import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiFetch } from "../lib/api";

function response(status: number, body: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

describe("createApiFetch", () => {
  it("sends the bearer token to /api and parses JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { ok: 1 }));
    const apiFetch = createApiFetch({ getToken: async () => "tok", onUnauthorized: vi.fn(), fetchImpl });

    await expect(apiFetch("/me")).resolves.toEqual({ ok: 1 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/me");
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(init.body).toBeUndefined();
  });

  it("serialises a JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(201, { id: "m1" }));
    const apiFetch = createApiFetch({ getToken: async () => "tok", onUnauthorized: vi.fn(), fetchImpl });
    await apiFetch("/conversations/c1/messages", { method: "POST", body: { text: "oi" } });
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ text: "oi" }));
  });

  it("calls onUnauthorized on 401 and when there is no session", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(response(401, { error: "unauthorized" }));
    const withToken = createApiFetch({ getToken: async () => "tok", onUnauthorized, fetchImpl });
    await expect(withToken("/me")).rejects.toMatchObject({ status: 401 });

    const noToken = createApiFetch({ getToken: async () => null, onUnauthorized, fetchImpl });
    await expect(noToken("/me")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws ApiError with status and body on other failures; empty 204 resolves null", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(409, { error: "taken" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const apiFetch = createApiFetch({ getToken: async () => "tok", onUnauthorized: vi.fn(), fetchImpl });
    await expect(apiFetch("/agents", { method: "POST", body: {} })).rejects.toMatchObject({ status: 409, body: { error: "taken" } });
    await expect(apiFetch("/instances/x", { method: "DELETE" })).resolves.toBeNull();
  });
});

describe("an account outside the allowlist (M15)", () => {
  it("calls onForbidden on 403 instead of leaving the page retrying forever", async () => {
    const onForbidden = vi.fn();
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(response(403, { error: "forbidden" }));
    const apiFetch = createApiFetch({ getToken: async () => "tok", onUnauthorized, onForbidden, fetchImpl });

    await expect(apiFetch("/me")).rejects.toMatchObject({ status: 403 });
    expect(onForbidden).toHaveBeenCalledOnce();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
