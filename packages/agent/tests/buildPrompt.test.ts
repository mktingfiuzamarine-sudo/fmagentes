import { describe, expect, it } from "vitest";
import type { AgentConfig, HistoryMessage } from "@fmagentes/messaging";
import { buildPrompt, customerContextBlock, PLATFORM_INSTRUCTIONS } from "../src/buildPrompt";

const AGENT: AgentConfig = {
  id: "agent-1",
  name: "Atendente",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  systemPrompt: "Somos a Loja Exemplo. Abrimos das 9h às 18h.",
  handoffMessage: "Já te passo.",
};

const at = (n: number) => `2026-10-14T12:00:0${n}Z`;
const user = (content: string, n = 0): HistoryMessage => ({ role: "user", content, createdAt: at(n) });
const assistant = (content: string, n = 0): HistoryMessage => ({ role: "assistant", content, createdAt: at(n) });

describe("customerContextBlock", () => {
  it("names a registered customer", () => {
    expect(customerContextBlock({ status: "registered", name: "Ana Souza" })).toBe("Cliente cadastrado: Ana Souza.");
  });

  it("omits the name when there is none (CPF link)", () => {
    expect(customerContextBlock({ status: "registered" })).toBe("Cliente cadastrado.");
  });

  it("tells the model to register an unregistered customer", () => {
    expect(customerContextBlock({ status: "unregistered" })).toBe(
      "Cliente SEM cadastro. Antes de prosseguir com o atendimento, peça nome completo, CPF e e-mail e chame cadastrar_cliente.",
    );
  });
});

describe("buildPrompt", () => {
  it("puts the cacheable instructions first and the customer block second", () => {
    const messages = buildPrompt({ agent: AGENT, history: [user("oi")], incoming: user("oi"), customer: { status: "unregistered" } });

    expect(messages[0]).toEqual({
      role: "system",
      content: `${PLATFORM_INSTRUCTIONS}\n\n## Instruções do negócio\n${AGENT.systemPrompt}`,
      experimental_providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(messages[1]).toEqual({ role: "system", content: `## Cliente\n${customerContextBlock({ status: "unregistered" })}` });
    expect(messages[2]).toEqual({ role: "user", content: "oi" });
  });

  it("keeps the cached block identical across customers", () => {
    const a = buildPrompt({ agent: AGENT, history: [user("oi")], incoming: user("oi"), customer: { status: "unregistered" } });
    const b = buildPrompt({ agent: AGENT, history: [user("oi")], incoming: user("oi"), customer: { status: "registered", name: "Ana" } });
    expect(a[0]).toEqual(b[0]);
  });

  it("maps history roles in order", () => {
    const messages = buildPrompt({
      agent: AGENT,
      history: [user("oi", 0), assistant("Olá!", 1), user("qual o horário?", 2)],
      incoming: user("qual o horário?", 2),
      customer: { status: "registered", name: "Ana" },
    });

    expect(messages.slice(2)).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: "Olá!" },
      { role: "user", content: "qual o horário?" },
    ]);
  });

  it("drops assistant messages at the start of a truncated window and blank messages", () => {
    const messages = buildPrompt({
      agent: AGENT,
      history: [assistant("resposta antiga", 0), assistant("outra", 1), user("  ", 2), user("oi", 3), assistant("", 4), user("tudo bem?", 5)],
      incoming: user("tudo bem?", 5),
      customer: { status: "unregistered" },
    });

    expect(messages.slice(2)).toEqual([
      { role: "user", content: "oi" },
      { role: "user", content: "tudo bem?" },
    ]);
  });

  describe("the message being answered", () => {
    it("moves it to the end when its device timestamp sorts it earlier", () => {
      const messages = buildPrompt({
        agent: AGENT,
        history: [user("oi", 0), user("qual o horário?", 1), assistant("Olá!", 2)],
        incoming: user("qual o horário?", 1),
        customer: { status: "unregistered" },
      });

      expect(messages.slice(2)).toEqual([
        { role: "user", content: "oi" },
        { role: "assistant", content: "Olá!" },
        { role: "user", content: "qual o horário?" },
      ]);
    });

    it("appends it when it fell out of the history window", () => {
      const messages = buildPrompt({
        agent: AGENT,
        history: [user("oi", 1), assistant("Olá!", 2)],
        incoming: user("e o preço?", 0),
        customer: { status: "unregistered" },
      });

      expect(messages.slice(2)).toEqual([
        { role: "user", content: "oi" },
        { role: "assistant", content: "Olá!" },
        { role: "user", content: "e o preço?" },
      ]);
    });

    it("does not duplicate it when it is already last", () => {
      const messages = buildPrompt({
        agent: AGENT,
        history: [user("oi", 0), assistant("Olá!", 1), user("oi", 2)],
        incoming: user("oi", 2),
        customer: { status: "unregistered" },
      });

      // Same text sent earlier stays: only the entry with the same createdAt is the incoming one.
      expect(messages.slice(2)).toEqual([
        { role: "user", content: "oi" },
        { role: "assistant", content: "Olá!" },
        { role: "user", content: "oi" },
      ]);
    });

    it("keeps the prompt starting with the user when the incoming was the first user message", () => {
      const messages = buildPrompt({
        agent: AGENT,
        history: [user("oi", 0), assistant("Olá!", 1)],
        incoming: user("oi", 0),
        customer: { status: "unregistered" },
      });

      expect(messages.slice(2)).toEqual([{ role: "user", content: "oi" }]);
    });

    it("does not append a blank incoming message", () => {
      const messages = buildPrompt({
        agent: AGENT,
        history: [user("oi", 0), assistant("Olá!", 1), user(" ", 2)],
        incoming: user(" ", 2),
        customer: { status: "unregistered" },
      });

      expect(messages.slice(2)).toEqual([
        { role: "user", content: "oi" },
        { role: "assistant", content: "Olá!" },
      ]);
    });
  });
});
