import { describe, expect, it } from "vitest";
import { envSchema, llmKeyWarning } from "../src/env";

const BASE = {
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "k",
  EVOLUTION_API_URL: "https://evo.example.com",
  EVOLUTION_API_KEY: "k",
  CRM_SUPABASE_URL: "https://crm.supabase.co",
  CRM_SUPABASE_SERVICE_KEY: "k",
  CRM_AGENT_USER_ID: "6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b",
};

describe("worker envSchema", () => {
  it("defaults the history limit to 30 and LLM keys to empty", () => {
    const env = envSchema.parse(BASE);
    expect(env.AGENT_HISTORY_LIMIT).toBe(30);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.OPENAI_API_KEY).toBe("");
  });

  it("parses AGENT_HISTORY_LIMIT from the string env", () => {
    expect(envSchema.parse({ ...BASE, AGENT_HISTORY_LIMIT: "12" }).AGENT_HISTORY_LIMIT).toBe(12);
  });

  it("rejects a non-uuid CRM_AGENT_USER_ID", () => {
    expect(envSchema.safeParse({ ...BASE, CRM_AGENT_USER_ID: "admin@crm" }).success).toBe(false);
  });

  it("rejects a zero history limit", () => {
    expect(envSchema.safeParse({ ...BASE, AGENT_HISTORY_LIMIT: "0" }).success).toBe(false);
  });
});

describe("llmKeyWarning", () => {
  it("warns when no LLM key is configured", () => {
    expect(llmKeyWarning(envSchema.parse(BASE))).toBe(
      "[worker] no LLM API key configured; every agent will fail as misconfigured",
    );
  });

  it("stays quiet when either key is set", () => {
    expect(llmKeyWarning(envSchema.parse({ ...BASE, ANTHROPIC_API_KEY: "sk-ant" }))).toBeNull();
    expect(llmKeyWarning(envSchema.parse({ ...BASE, OPENAI_API_KEY: "sk-oa" }))).toBeNull();
  });
});
