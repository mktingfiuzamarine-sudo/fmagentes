import { describe, expect, it } from "vitest";
import { EchoResponder } from "../src/responder";
import type { ResponderInput } from "../src/responder";

function input(text: string): ResponderInput {
  const incoming = { role: "user" as const, content: text, createdAt: "2026-09-17T10:00:00Z" };
  return {
    agent: { id: "a1", name: "Bot", provider: "anthropic", model: "claude-opus-5", systemPrompt: "" },
    history: [incoming],
    incoming,
  };
}

describe("EchoResponder", () => {
  it("echoes the incoming text back with a prefix", async () => {
    await expect(new EchoResponder().generate(input("oi"))).resolves.toBe("Echo: oi");
  });

  it("declines to answer an empty message", async () => {
    await expect(new EchoResponder().generate(input("   "))).resolves.toBeNull();
  });
});
