import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerDeps } from "../src/deps";
import type { Env } from "../src/env";

const ENV: Env = {
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "https://main.supabase.co",
  SUPABASE_SERVICE_KEY: "service",
  EVOLUTION_API_URL: "https://evolution.example",
  EVOLUTION_API_KEY: "evo",
  CRM_SUPABASE_URL: "https://crm.supabase.co",
  CRM_SUPABASE_SERVICE_KEY: "crm-service",
  CRM_AGENT_USER_ID: "00000000-0000-4000-8000-000000000001",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  AGENT_HISTORY_LIMIT: 30,
};

/** A server that never answers: resolves only when the request is aborted. */
function hangingFetch(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWorkerDeps", () => {
  it("gives the main Supabase client a request timeout, so a hung call cannot hold the conversation lock", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const deps = createWorkerDeps(ENV, {} as never, { requestTimeoutMs: 50 });

    const started = Date.now();
    // A write: postgrest-js retries reads (with 1-4 s backoff), which would only slow the test down.
    const result = await deps.supabase.from("messages").insert({ content: "x" });

    expect(result.error).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("passes the history limit through", () => {
    const deps = createWorkerDeps({ ...ENV, AGENT_HISTORY_LIMIT: 12 }, {} as never);
    expect(deps.historyLimit).toBe(12);
  });
});
