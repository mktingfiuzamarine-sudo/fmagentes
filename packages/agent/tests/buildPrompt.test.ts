import { describe, expect, it } from "vitest";
import type { AgentConfig, HistoryMessage } from "@fmagentes/messaging";
import type { CrmSnapshot } from "../src/crm/CrmPort";
import { buildPrompt, customerContextBlock, MAX_PROMPT_MESSAGE_CHARS, PLATFORM_INSTRUCTIONS } from "../src/buildPrompt";

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
    expect(customerContextBlock({ status: "registered", crmClientId: "crm-1", verified: true, name: "Ana Souza" })).toBe("Cliente cadastrado: Ana Souza. Trate o cliente pelo nome.");
  });

  it("omits the name when there is none", () => {
    expect(customerContextBlock({ status: "registered", crmClientId: "crm-1", verified: true })).toBe("Cliente cadastrado.");
  });

  it("tells the model to register an unregistered customer", () => {
    expect(customerContextBlock({ status: "unregistered" })).toBe(
      "Cliente SEM cadastro. Antes de prosseguir com o atendimento, peça nome completo, CPF ou CNPJ e e-mail e chame cadastrar_cliente.",
    );
  });
});

describe("customerContextBlock with a CRM snapshot", () => {
  const snapshot: CrmSnapshot = {
    missingClientFields: ["landline", "birthday", "lead_source"],
    vessels: [{ id: "v-1", kind: "barco_lancha", summary: "Lancha Fibra 6 m" }],
    openDeals: [{ id: "d-1", pipeline: "vendas", stageLabel: "Lead", title: "Compra de jet ski", details: "" }],
  };

  it("shows what is saved in each open deal, so the model can confirm it", () => {
    const withDetails: CrmSnapshot = {
      ...snapshot,
      openDeals: [{ ...snapshot.openDeals[0], details: "Marca: Yamaha · Modelo: VX · Ano: 2020" }],
    };
    expect(customerContextBlock(verified, withDetails).split("\n")).toContain(
      "- Vendas · Lead · Compra de jet ski · Marca: Yamaha · Modelo: VX · Ano: 2020 (negocio_id: d-1)",
    );
  });
  const empty: CrmSnapshot = { missingClientFields: [], vessels: [], openDeals: [] };
  const verified = { status: "registered", crmClientId: "crm-1", verified: true, name: "Ana Souza" } as const;
  const unverified = { status: "registered", crmClientId: "crm-1", verified: false } as const;
  const FIRST = "Cliente cadastrado: Ana Souza. Trate o cliente pelo nome.";

  it("shows the verified customer's record, one line each, in order", () => {
    expect(customerContextBlock(verified, snapshot).split("\n")).toEqual([
      FIRST,
      "Campos da ficha ainda vazios: Telefone fixo, Aniversário, Origem do lead.",
      "Origem do lead vazia: pergunte uma única vez nesta conversa, de forma leve, como o cliente conheceu a Fiuza Marine, e grave com atualizar_cliente.",
      "Embarcações do cliente:",
      "- Lancha Fibra 6 m (embarcacao_id: v-1)",
      "Negócios abertos:",
      "- Vendas · Lead · Compra de jet ski (negocio_id: d-1)",
    ]);
  });

  it("omits empty sections and the lead-source line when it is not missing", () => {
    expect(customerContextBlock(verified, { ...empty, missingClientFields: ["company"] })).toBe(`${FIRST}\nCampos da ficha ainda vazios: Empresa.`);
    expect(customerContextBlock(verified, empty)).toBe(FIRST);
  });

  it("uses the bare first line for a verified customer without a name", () => {
    expect(customerContextBlock({ ...verified, name: undefined }, empty)).toBe("Cliente cadastrado.");
  });

  it("keeps an unverified link blind to the record, listing only what the snapshot returned", () => {
    const first =
      "Cliente identificado pelo CPF/CNPJ que digitou, sem confirmação. Não cite nenhum dado do cadastro. Você pode registrar embarcações e negócios novos; não atualize a ficha.";
    expect(customerContextBlock(unverified, snapshot).split("\n")).toEqual([
      first,
      "Embarcações do cliente:",
      "- Lancha Fibra 6 m (embarcacao_id: v-1)",
      "Negócios abertos:",
      "- Vendas · Lead · Compra de jet ski (negocio_id: d-1)",
    ]);
    expect(customerContextBlock(unverified, empty)).toBe(first);
  });

  it("gives a registered customer only the first line without a snapshot", () => {
    expect(customerContextBlock(verified)).toBe(FIRST);
  });
});

describe("PLATFORM_INSTRUCTIONS CRM rules", () => {
  it("carries the CRM rules", () => {
    for (const line of [
      "- Nunca mostre ao cliente nomes internos do sistema: ids (embarcacao_id, negocio_id), nomes de ferramentas ou de campos. Fale como um atendente, com palavras do dia a dia.",
      "- Quando o cliente mencionar algo que tem lugar no CRM (dados dele, embarcações ou motores que já tem, o que quer comprar, consórcio, peça, conserto), grave com a ferramenta certa, aos poucos, sem avisar nem pedir confirmação.",
      "- Pergunte só o que for necessário para o próximo passo do atendimento, uma coisa por vez. Se o cliente não souber ou não quiser responder, siga em frente. Nunca faça uma lista de perguntas.",
      "- Abra o negócio pelo assunto: compra de barco, lancha, jet ski ou motor → vendas; consórcio → consorcios; peça ou acessório → pecas; conserto, revisão ou manutenção → manutencao. Em manutenção, informe o embarcacao_id da embarcação ou motor: use o id que registrar_embarcacao devolveu ou um da lista Embarcações do cliente, nunca um negocio_id nem um id inventado. Se ainda não souber qual é, abra o negócio de manutenção sem embarcacao_id e complete depois.",
      "- Motor de popa que o cliente já tem: se não souber a potência, pergunte. Até 30 HP é portátil: registre como motor_popa, sem perguntar do barco. Acima de 30 HP, pergunte uma vez se o motor está instalado em um barco ou lancha; se estiver, registre o barco (barco_lancha) com os dados do motor em tipo_motor popa, quantidade_motores, marca_motor, potencia_hp e ano_motor, e use esse barco na manutenção; se não estiver, registre como motor_popa.",
      "- Cada assunto é um negócio separado, e o mesmo cliente pode ter vários ao mesmo tempo (por exemplo: quer comprar um motor novo e também fazer revisão no motor que já tem). A cada mensagem, veja se o cliente mudou de assunto; se mudou, abra o negócio do novo funil e não grave os dados do novo assunto no negócio anterior.",
      "- O que o cliente quer comprar vai no departamento de vendas. O barco, lancha, jet ski ou motor que ele já tem vai em registrar_embarcacao, nunca nos campos marca, modelo e ano do departamento de vendas.",
      "- Nunca diga que vai fazer algo depois (\"um momento\", \"vou verificar\", \"vou registrar\"): grave com a ferramenta na mesma resposta. Você não consulta estoque, disponibilidade nem prazo; se o cliente pedir isso, colete o que faltar e transfira para um atendente humano.",
      "- Nunca pergunte, sugira ou grave valores em dinheiro.",
    ]) {
      expect(PLATFORM_INSTRUCTIONS).toContain(line);
    }
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
    const b = buildPrompt({ agent: AGENT, history: [user("oi")], incoming: user("oi"), customer: { status: "registered", crmClientId: "crm-1", verified: true, name: "Ana" } });
    expect(a[0]).toEqual(b[0]);
  });

  it("maps history roles in order", () => {
    const messages = buildPrompt({
      agent: AGENT,
      history: [user("oi", 0), assistant("Olá!", 1), user("qual o horário?", 2)],
      incoming: user("qual o horário?", 2),
      customer: { status: "registered", crmClientId: "crm-1", verified: true, name: "Ana" },
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

describe("buildPrompt caps long messages (M9)", () => {
  const AGENT_ = { id: "a", name: "A", provider: "anthropic", model: "m", systemPrompt: "x", handoffMessage: "h" };

  it("cuts any message over MAX_PROMPT_MESSAGE_CHARS and says so", () => {
    const long = "a".repeat(MAX_PROMPT_MESSAGE_CHARS + 500);
    const incoming = { role: "user" as const, content: long, createdAt: "2026-10-14T12:00:00Z" };

    const prompt = buildPrompt({
      agent: AGENT_,
      history: [{ role: "user", content: long, createdAt: "2026-10-14T11:00:00Z" }, incoming],
      incoming,
      customer: { status: "registered", crmClientId: "crm-1", verified: false },
    });

    const turns = prompt.slice(2).map((message) => String(message.content));
    expect(turns).toHaveLength(2);
    for (const content of turns) {
      expect(content.length).toBeLessThan(MAX_PROMPT_MESSAGE_CHARS + 100);
      expect(content).toMatch(/mensagem cortada/);
    }
  });

  it("leaves ordinary messages untouched", () => {
    const incoming = { role: "user" as const, content: "oi", createdAt: "2026-10-14T12:00:00Z" };
    const prompt = buildPrompt({ agent: AGENT_, history: [incoming], incoming, customer: { status: "registered", crmClientId: "crm-1", verified: false } });
    expect(prompt[2].content).toBe("oi");
  });
});
