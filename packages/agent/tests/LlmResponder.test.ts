import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV1 } from "ai/test";
import { APICallError } from "ai";
import type { LanguageModelV1CallOptions } from "ai";
import { ResponderConfigurationError, type ResponderInput } from "@fmagentes/messaging";
import { LlmResponder } from "../src/LlmResponder";
import { createFakeCrm } from "./support/fakeCrm";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV1["doGenerate"]>>;

const base = {
  rawCall: { rawPrompt: null, rawSettings: {} },
  usage: { promptTokens: 10, completionTokens: 5 },
} as const;

const text = (value: string): GenerateResult => ({ ...base, finishReason: "stop", text: value });

const toolCall = (toolName: string, args: object, id = "call-1"): GenerateResult => ({
  ...base,
  finishReason: "tool-calls",
  toolCalls: [{ toolCallType: "function", toolCallId: id, toolName, args: JSON.stringify(args) }],
});

/** A model that answers each step with the next scripted response. */
function scripted(...responses: GenerateResult[]) {
  const calls: LanguageModelV1CallOptions[] = [];
  const model = new MockLanguageModelV1({
    doGenerate: async (options) => {
      calls.push(options);
      const next = responses[calls.length - 1];
      if (!next) throw new Error(`unexpected step ${calls.length}`);
      return next;
    },
  });
  return { model, calls };
}

const INPUT: ResponderInput = {
  agent: {
    id: "agent-1",
    name: "Atendente",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    systemPrompt: "Somos a Loja Exemplo.",
    handoffMessage: "Já te passo.",
  },
  history: [{ role: "user", content: "oi", createdAt: "2026-10-14T12:00:00Z" }],
  incoming: { role: "user", content: "oi", createdAt: "2026-10-14T12:00:00Z" },
  conversationId: "conv-1",
  contactPhone: "5511988887777",
  customer: { status: "unregistered" },
};

function responderWith(model: MockLanguageModelV1, overrides: { crm?: ReturnType<typeof createFakeCrm>; timeoutMs?: number; keys?: Partial<{ anthropicApiKey: string; openaiApiKey: string }> } = {}) {
  const createModel = vi.fn(() => model);
  const responder = new LlmResponder({
    llm: { anthropicApiKey: "a-key", openaiApiKey: "o-key", ...overrides.keys },
    crm: overrides.crm ?? createFakeCrm(),
    timeoutMs: overrides.timeoutMs,
    createModel,
  });
  return { responder, createModel };
}

describe("LlmResponder", () => {
  it("returns the model's text as a reply", async () => {
    const { model } = scripted(text("  Olá! Como posso ajudar?  "));
    const { responder, createModel } = responderWith(model);

    await expect(responder.generate(INPUT)).resolves.toEqual({ kind: "reply", text: "Olá! Como posso ajudar?" });
    expect(createModel).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
  });

  it("sends the built prompt", async () => {
    const { model, calls } = scripted(text("Olá!"));
    const { responder } = responderWith(model);

    await responder.generate(INPUT);

    const prompt = calls[0].prompt;
    expect(prompt[0]).toMatchObject({ role: "system" });
    expect((prompt[0] as { content: string }).content).toContain("Somos a Loja Exemplo.");
    expect((prompt[1] as { content: string }).content).toContain("Cliente SEM cadastro");
    expect(prompt[2]).toMatchObject({ role: "user" });
  });

  it("offers both tools to an unregistered customer and only handoff to a registered one", async () => {
    const toolNames = (options: LanguageModelV1CallOptions) =>
      options.mode.type === "regular" ? (options.mode.tools ?? []).map((t) => t.name).sort() : [];

    const first = scripted(text("ok"));
    await responderWith(first.model).responder.generate(INPUT);
    expect(toolNames(first.calls[0])).toEqual(["cadastrar_cliente", "transferir_para_humano"]);

    const second = scripted(text("ok"));
    await responderWith(second.model).responder.generate({ ...INPUT, customer: { status: "registered", name: "Ana" } });
    expect(toolNames(second.calls[0])).toEqual(["transferir_para_humano"]);
  });

  it("turns a handoff tool call into a handoff with its summary", async () => {
    const { model, calls } = scripted(toolCall("transferir_para_humano", { resumo: "Quer orçamento de casco" }));
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).resolves.toEqual({ kind: "handoff", summary: "Quer orçamento de casco" });
    expect(calls).toHaveLength(1); // no execute → the loop stops
  });

  it("lets a handoff win over text in the same step", async () => {
    const { model } = scripted({
      ...toolCall("transferir_para_humano", { resumo: "Pediu humano" }),
      text: "Vou transferir você agora!",
    });
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).resolves.toEqual({ kind: "handoff", summary: "Pediu humano" });
  });

  it("declines when the final text is blank", async () => {
    const { model } = scripted(text("   "));
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).resolves.toEqual({ kind: "decline" });
  });

  it("registers through the tool and reports the link with the reply", async () => {
    const crm = createFakeCrm();
    const { model, calls } = scripted(
      toolCall("cadastrar_cliente", { nome: "Bruno Lima", cpf: "529.982.247-25", email: "bruno@example.com" }),
      text("Pronto, cadastro feito! Em que posso ajudar?"),
    );
    const { responder } = responderWith(model, { crm });

    await expect(responder.generate(INPUT)).resolves.toEqual({
      kind: "reply",
      text: "Pronto, cadastro feito! Em que posso ajudar?",
      linkedCustomer: { crmClientId: "crm-new", via: "created" },
    });
    expect(crm.create).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
  });

  it("rethrows a transient provider error untouched so BullMQ retries", async () => {
    const rateLimited = new APICallError({
      message: "rate limited",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
    });
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        throw rateLimited;
      },
    });
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).rejects.toBe(rateLimited);
  });

  it.each([401, 403, 404])("treats HTTP %i as a configuration error", async (statusCode) => {
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        throw new APICallError({ message: "nope", url: "u", requestBodyValues: {}, statusCode, isRetryable: false });
      },
    });
    const { responder } = responderWith(model);

    const error = await responder.generate(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponderConfigurationError);
    expect((error as ResponderConfigurationError).agentId).toBe("agent-1");
  });

  it("rejects an unknown provider before calling any model", async () => {
    const { model, calls } = scripted(text("never"));
    const { responder, createModel } = responderWith(model);

    await expect(
      responder.generate({ ...INPUT, agent: { ...INPUT.agent, provider: "echo" } }),
    ).rejects.toBeInstanceOf(ResponderConfigurationError);
    expect(createModel).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("rejects a provider whose API key is not configured", async () => {
    const { model } = scripted(text("never"));
    const { responder } = responderWith(model, { keys: { openaiApiKey: "" } });

    await expect(
      responder.generate({ ...INPUT, agent: { ...INPUT.agent, provider: "openai", model: "gpt-4o" } }),
    ).rejects.toBeInstanceOf(ResponderConfigurationError);
  });

  it("aborts a call that exceeds the timeout as a transient error", async () => {
    const model = new MockLanguageModelV1({
      doGenerate: ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
        }),
    });
    const { responder } = responderWith(model, { timeoutMs: 20 });

    const error = await responder.generate(INPUT).catch((e: unknown) => e);
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(ResponderConfigurationError);
  });
});
