import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV1 } from "ai/test";
import { APICallError } from "ai";
import type { LanguageModelV1CallOptions } from "ai";
import { ResponderConfigurationError, type ResponderInput } from "@fmagentes/messaging";
import { LlmResponder, MAX_STEPS } from "../src/LlmResponder";
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

  const toolNames = (options: LanguageModelV1CallOptions) =>
    options.mode.type === "regular" ? (options.mode.tools ?? []).map((t) => t.name).sort() : [];
  const VERIFIED = { status: "registered", crmClientId: "crm-1", verified: true, name: "Ana" } as const;

  it("offers handoff and registration to an unregistered customer", async () => {
    const { model, calls } = scripted(text("ok"));
    await responderWith(model).responder.generate(INPUT);
    expect(toolNames(calls[0])).toEqual(["cadastrar_cliente", "transferir_para_humano"]);
  });

  it("offers handoff, atualizar_cliente, registrar_embarcacao and registrar_negocio to a verified customer", async () => {
    const { model, calls } = scripted(text("ok"));
    await responderWith(model).responder.generate({ ...INPUT, customer: VERIFIED });
    expect(toolNames(calls[0])).toEqual(["atualizar_cliente", "registrar_embarcacao", "registrar_negocio", "transferir_para_humano"]);
  });

  it("offers no atualizar_cliente on an unverified link", async () => {
    const { model, calls } = scripted(text("ok"));
    await responderWith(model).responder.generate({ ...INPUT, customer: { status: "registered", crmClientId: "crm-1", verified: false } });
    expect(toolNames(calls[0])).toEqual(["registrar_embarcacao", "registrar_negocio", "transferir_para_humano"]);
  });

  it("loads the snapshot only for registered customers", async () => {
    const crm = createFakeCrm();
    const a = scripted(text("ok"));
    await responderWith(a.model, { crm }).responder.generate(INPUT);
    expect(crm.loadSnapshot).not.toHaveBeenCalled();

    crm.loadSnapshot.mockResolvedValueOnce({ missingClientFields: ["company"], vessels: [], openDeals: [] });
    const b = scripted(text("ok"));
    await responderWith(b.model, { crm }).responder.generate({ ...INPUT, customer: VERIFIED });
    expect(crm.loadSnapshot).toHaveBeenCalledWith({ clientId: "crm-1", verified: true, conversationId: "conv-1" });
    expect((b.calls[0].prompt[1] as { content: string }).content).toContain("Campos da ficha ainda vazios: Empresa.");
  });

  it("reads a null optional field as absent instead of failing the turn", async () => {
    const crm = createFakeCrm();
    const { model } = scripted(
      toolCall("atualizar_cliente", { email: "ana@example.com", telefone_fixo: null }, "c1"),
      toolCall("registrar_embarcacao", { tipo: "motor_popa", marca: null, potencia_hp: 115 }, "c2"),
      text("Anotado!"),
    );
    await expect(responderWith(model, { crm }).responder.generate({ ...INPUT, customer: VERIFIED })).resolves.toEqual({
      kind: "reply",
      text: "Anotado!",
    });
    expect(crm.fillClient).toHaveBeenCalledWith(expect.anything(), { email: "ana@example.com" });
    expect(crm.createVessel).toHaveBeenCalledWith(expect.anything(), "motor_popa", { horsepower: 115 });
  });

  it("logs each tool call, showing values only for non-personal fields", async () => {
    const crm = createFakeCrm();
    const lines: string[] = [];
    const { model } = scripted(
      toolCall("atualizar_cliente", { email: "ana@example.com" }, "c1"),
      toolCall("registrar_negocio", { funil: "manutencao", titulo: "Revisão da Ana" }, "c2"),
      text("Anotado!"),
    );
    const responder = new LlmResponder({
      llm: { anthropicApiKey: "a-key", openaiApiKey: "o-key" },
      crm,
      createModel: () => model,
      logToolCall: (line) => lines.push(line),
    });
    await responder.generate({ ...INPUT, customer: VERIFIED });
    expect(lines).toEqual([
      "[tool] conv conv-1 atualizar_cliente email -> Salvo.",
      '[tool] conv conv-1 registrar_negocio funil="manutencao" titulo -> Negócio aberto (negocio_id: deal-new).',
    ]);
    expect(lines.join("\n")).not.toContain("ana@example.com");
    expect(lines.join("\n")).not.toContain("Revisão da Ana");
  });

  it("still sends every tool's parameters as a JSON object schema", async () => {
    const { model, calls } = scripted(text("ok"));
    await responderWith(model).responder.generate({ ...INPUT, customer: VERIFIED });
    const tools = calls[0].mode.type === "regular" ? (calls[0].mode.tools ?? []) : [];
    expect(tools.length).toBe(4);
    for (const t of tools) {
      const schema = (t as { parameters: { type?: string; properties?: object } }).parameters;
      expect(schema.type, t.name).toBe("object");
      expect(schema.properties, t.name).toBeDefined();
    }
  });

  it("does not send a promise to act later: asks the model to act now, then replies", async () => {
    const crm = createFakeCrm();
    const { model, calls } = scripted(
      text("Vou registrar seu interesse na hélice. Um momento, por favor."),
      toolCall("registrar_negocio", { funil: "pecas", titulo: "Hélice", descricao_peca: "Hélice Yamaha 115" }, "c1"),
      text("Pronto, anotei a hélice para o seu Yamaha 115."),
    );
    const result = await responderWith(model, { crm }).responder.generate({ ...INPUT, customer: VERIFIED });

    expect(result).toEqual({ kind: "reply", text: "Pronto, anotei a hélice para o seu Yamaha 115." });
    expect(crm.createDeal).toHaveBeenCalledWith(expect.anything(), "pecas", "Hélice", { part_description: "Hélice Yamaha 115" });
    const nudge = calls[1].prompt.at(-1) as { role: string; content: string };
    expect(nudge.role).toBe("system");
    expect(nudge.content).toContain("chame a ferramenta agora");
  });

  it("asks only once: a second promise is sent as it is", async () => {
    const { model, calls } = scripted(text("Um momento."), text("Um momento, já volto."));
    await expect(responderWith(model).responder.generate({ ...INPUT, customer: VERIFIED })).resolves.toEqual({
      kind: "reply",
      text: "Um momento, já volto.",
    });
    expect(calls).toHaveLength(2);
  });

  it("does not send a claim of saving when nothing was saved: asks the model to save now", async () => {
    const crm = createFakeCrm();
    const { model, calls } = scripted(
      text("Registrei seu interesse em comprar um motor de popa Suzuki 250 HP."),
      toolCall("registrar_negocio", { funil: "vendas", titulo: "Compra motor Suzuki 250 HP", tipo_produto: "motor_popa" }, "c1"),
      text("Pronto! Registrei seu interesse no Suzuki 250 HP."),
    );
    const result = await responderWith(model, { crm }).responder.generate({ ...INPUT, customer: VERIFIED });

    expect(result).toEqual({ kind: "reply", text: "Pronto! Registrei seu interesse no Suzuki 250 HP." });
    expect(crm.createDeal).toHaveBeenCalledTimes(1);
    const nudge = calls[1].prompt.at(-1) as { role: string; content: string };
    expect(nudge.role).toBe("system");
    expect(nudge.content).toContain("não chamou nenhuma ferramenta");
  });

  it("sends a claim of saving as it is when a save really happened", async () => {
    const { model, calls } = scripted(
      toolCall("registrar_negocio", { funil: "pecas", titulo: "Hélice" }, "c1"),
      text("Registrei seu pedido da hélice."),
    );
    await expect(responderWith(model).responder.generate({ ...INPUT, customer: VERIFIED })).resolves.toEqual({
      kind: "reply",
      text: "Registrei seu pedido da hélice.",
    });
    expect(calls).toHaveLength(2);
  });

  it("does not ask again for an ordinary reply", async () => {
    const { model, calls } = scripted(text("Qual é a potência do motor?"));
    await responderWith(model).responder.generate({ ...INPUT, customer: VERIFIED });
    expect(calls).toHaveLength(1);
  });

  it("lets the model save twice and still reply", async () => {
    const { model, calls } = scripted(
      toolCall("atualizar_cliente", { empresa: "Acme" }, "c1"),
      toolCall("registrar_embarcacao", { tipo: "jet_ski" }, "c2"),
      text("Anotado!"),
    );
    await expect(responderWith(model).responder.generate({ ...INPUT, customer: VERIFIED })).resolves.toEqual({ kind: "reply", text: "Anotado!" });
    expect(calls).toHaveLength(3);
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

  it("hands off when every step went to tool calls and no text came out (M10)", async () => {
    const invalid = { nome: "X", cpf_cnpj: "111.111.111-11", email: "x@example.com" };
    const { model, calls } = scripted(
      ...Array.from({ length: MAX_STEPS }, (_, i) => toolCall("cadastrar_cliente", invalid, `c${i}`)),
    );
    const { responder } = responderWith(model);

    const result = await responder.generate(INPUT);

    expect(calls).toHaveLength(MAX_STEPS);
    expect(result).toEqual({ kind: "handoff", summary: expect.stringMatching(/não concluiu/) });
  });

  it("registers through the tool and reports the link with the reply", async () => {
    const crm = createFakeCrm();
    const { model, calls } = scripted(
      toolCall("cadastrar_cliente", { nome: "Bruno Lima", cpf_cnpj: "529.982.247-25", email: "bruno@example.com" }),
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

  it("treats Anthropic's out-of-credit 400 as misconfiguration: retrying cannot fix billing", async () => {
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        throw new APICallError({
          message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
          url: "https://api.anthropic.com/v1/messages",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      },
    });
    const { responder } = responderWith(model);

    await expect(responder.generate(INPUT)).rejects.toBeInstanceOf(ResponderConfigurationError);
  });

  it("keeps any other 400 an ordinary failure", async () => {
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        throw new APICallError({ message: "messages: text content blocks must be non-empty", url: "u", requestBodyValues: {}, statusCode: 400, isRetryable: false });
      },
    });
    const { responder } = responderWith(model);

    const error = await responder.generate(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APICallError);
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
