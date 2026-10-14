import { describe, expect, it } from "vitest";
import { EchoResponder, ResponderConfigurationError } from "../src/responder";
import type { ResponderInput } from "../src/responder";

function input(text: string): ResponderInput {
  const incoming = { role: "user" as const, content: text, createdAt: "2026-09-17T10:00:00Z" };
  return {
    agent: {
      id: "a1",
      name: "Bot",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      systemPrompt: "",
      handoffMessage: "Já te passo.",
    },
    history: [incoming],
    incoming,
    conversationId: "conv-1",
    contactPhone: "5511999998888",
    customer: { status: "unregistered" },
  };
}

describe("EchoResponder", () => {
  it("echoes the incoming text back as a reply", async () => {
    await expect(new EchoResponder().generate(input("oi"))).resolves.toEqual({ kind: "reply", text: "Echo: oi" });
  });

  it("declines an empty message", async () => {
    await expect(new EchoResponder().generate(input("   "))).resolves.toEqual({ kind: "decline" });
  });
});

describe("ResponderConfigurationError", () => {
  it("carries the agent id", () => {
    const error = new ResponderConfigurationError("agent-9", "bad key");
    expect(error.agentId).toBe("agent-9");
    expect(error.message).toBe("bad key");
    expect(error.name).toBe("ResponderConfigurationError");
  });
});
