import { describe, expect, it } from "vitest";
import { registerDeal } from "../src/tools/registerDeal";
import { CrmNotInScopeError, type CrmScope } from "../src/crm/CrmPort";
import { createFakeCrm } from "./support/fakeCrm";

const SCOPE: CrmScope = { clientId: "crm-1", verified: true, conversationId: "conv-1" };
const VESSEL_ID = "0b6f1c1e-3a4d-4c5e-8f90-123456789abc";
const NOT_FOUND = "Erro: registro não encontrado. Não cite este erro ao cliente; continue o atendimento.";
const UNKNOWN_VESSEL =
  " A embarcação informada não existe e ficou de fora. Não invente embarcacao_id: pergunte ao cliente sobre o barco ou motor, registre com registrar_embarcacao e complete este negócio com o embarcacao_id devolvido.";

describe("registerDeal", () => {
  it("opens a deal when none is open in the pipeline", async () => {
    const crm = createFakeCrm();
    const answer = await registerDeal(crm, SCOPE, { funil: "vendas", titulo: "Compra jet ski", tipo_produto: "jet_ski" });

    expect(crm.findOpenDeal).toHaveBeenCalledWith(SCOPE, "vendas");
    expect(crm.createDeal).toHaveBeenCalledWith(SCOPE, "vendas", "Compra jet ski", { product_type: "jet_ski" });
    expect(answer).toBe("Negócio aberto (negocio_id: deal-new).");
  });

  it("completes the open deal instead of creating another", async () => {
    const crm = createFakeCrm();
    crm.findOpenDeal.mockResolvedValue({ id: "deal-1" });
    crm.fillDeal.mockResolvedValue({ filled: ["brand"], conflicts: [] });
    const answer = await registerDeal(crm, SCOPE, { funil: "vendas", titulo: "Compra", marca: "Yamaha" });

    expect(crm.fillDeal).toHaveBeenCalledWith(SCOPE, "deal-1", { brand: "Yamaha" });
    expect(crm.createDeal).not.toHaveBeenCalled();
    expect(answer).toBe("Negócio já aberto neste funil foi atualizado (negocio_id: deal-1).");
  });

  it("says nothing new was saved when the open deal already had it", async () => {
    const crm = createFakeCrm();
    crm.findOpenDeal.mockResolvedValue({ id: "deal-1" });
    const answer = await registerDeal(crm, SCOPE, { funil: "vendas", titulo: "Compra", marca: "Yamaha" });
    expect(answer).toBe("Negócio já aberto neste funil (negocio_id: deal-1). Nada novo para salvar.");
  });

  it("drops a year outside 1900-2100 and says so", async () => {
    const crm = createFakeCrm();
    const answer = await registerDeal(crm, SCOPE, { funil: "vendas", titulo: "Lancha", ano: 98, modelo: "X" });
    expect(crm.createDeal).toHaveBeenCalledWith(SCOPE, "vendas", "Lancha", { model: "X" });
    expect(answer).toBe("Negócio aberto (negocio_id: deal-new). Não salvo por estar fora do esperado: Ano.");
  });

  it("caps the title at 120 characters on one line", async () => {
    const crm = createFakeCrm();
    await registerDeal(crm, SCOPE, { funil: "pecas", titulo: "a\n" + "b".repeat(200) });
    const title = crm.createDeal.mock.calls[0][2];
    expect(title).toBe(("a " + "b".repeat(200)).slice(0, 120));
  });

  it("appends conflicts by label, never the values", async () => {
    const crm = createFakeCrm();
    const STORED = "Segredo-Guardado";
    crm.loadSnapshot.mockResolvedValue({
      missingClientFields: [],
      vessels: [],
      openDeals: [{ id: "deal-1", pipeline: "vendas", stageLabel: "Lead", title: STORED, details: "" }],
    });
    crm.findOpenDeal.mockResolvedValue({ id: "deal-1" });
    crm.fillDeal.mockResolvedValue({ filled: [], conflicts: ["brand"] });
    const answer = await registerDeal(crm, SCOPE, { funil: "vendas", titulo: "x", marca: "Outra" });
    expect(answer).toBe(
      "Negócio já aberto neste funil foi atualizado (negocio_id: deal-1). Já havia outro valor salvo para: Marca; a equipe vai conferir.",
    );
    expect(answer).not.toContain(STORED);
  });

  it("drops fields that do not belong to the pipeline", async () => {
    const crm = createFakeCrm();
    await registerDeal(crm, SCOPE, { funil: "vendas", titulo: "Compra", descricao_servico: "Revisão", administradora: "X" });
    expect(crm.createDeal).toHaveBeenCalledWith(SCOPE, "vendas", "Compra", {});
  });

  it("maps maintenance fields", async () => {
    const crm = createFakeCrm();
    await registerDeal(crm, SCOPE, {
      funil: "manutencao",
      titulo: "Revisão Mercury 150 HP",
      embarcacao_id: VESSEL_ID,
      descricao_servico: "Revisão",
    });
    expect(crm.createDeal).toHaveBeenCalledWith(SCOPE, "manutencao", "Revisão Mercury 150 HP", {
      vessel_id: VESSEL_ID,
      service_description: "Revisão",
    });
  });

  it("opens the deal without an unknown (invented or out-of-scope) vessel and says what to do", async () => {
    const crm = createFakeCrm();
    crm.createDeal.mockRejectedValueOnce(new CrmNotInScopeError());
    const answer = await registerDeal(crm, SCOPE, {
      funil: "manutencao",
      titulo: "Revisão",
      embarcacao_id: VESSEL_ID,
      descricao_servico: "Revisão",
    });
    expect(crm.createDeal).toHaveBeenLastCalledWith(SCOPE, "manutencao", "Revisão", { service_description: "Revisão" });
    expect(answer).toBe(`Negócio aberto (negocio_id: deal-new).${UNKNOWN_VESSEL}`);
  });

  it("drops a malformed embarcacao_id before calling the CRM, with the same answer", async () => {
    const crm = createFakeCrm();
    const answer = await registerDeal(crm, SCOPE, { funil: "manutencao", titulo: "x", embarcacao_id: "f4c3e5b4-5c3e-4c5b-8e3b-5c3e5b4c5e3" });
    expect(crm.createDeal).toHaveBeenCalledTimes(1);
    expect(crm.createDeal).toHaveBeenCalledWith(SCOPE, "manutencao", "x", {});
    expect(answer).toBe(`Negócio aberto (negocio_id: deal-new).${UNKNOWN_VESSEL}`);
  });

  it("completes the open deal without an unknown vessel", async () => {
    const crm = createFakeCrm();
    crm.findOpenDeal.mockResolvedValue({ id: "deal-1" });
    crm.fillDeal.mockRejectedValueOnce(new CrmNotInScopeError());
    crm.fillDeal.mockResolvedValueOnce({ filled: ["service_description"], conflicts: [] });
    const answer = await registerDeal(crm, SCOPE, { funil: "manutencao", titulo: "x", embarcacao_id: VESSEL_ID, descricao_servico: "Óleo" });
    expect(crm.fillDeal).toHaveBeenLastCalledWith(SCOPE, "deal-1", { service_description: "Óleo" });
    expect(answer).toBe(`Negócio já aberto neste funil foi atualizado (negocio_id: deal-1).${UNKNOWN_VESSEL}`);
  });

  it("keeps the neutral error when the deal itself is out of scope", async () => {
    const crm = createFakeCrm();
    crm.createDeal.mockRejectedValue(new CrmNotInScopeError());
    expect(await registerDeal(crm, SCOPE, { funil: "pecas", titulo: "x" })).toBe(NOT_FOUND);
  });

  it("rethrows other CRM errors", async () => {
    const crm = createFakeCrm();
    crm.findOpenDeal.mockRejectedValue(new Error("kept changing"));
    await expect(registerDeal(crm, SCOPE, { funil: "pecas", titulo: "x" })).rejects.toThrow("kept changing");
  });
});
