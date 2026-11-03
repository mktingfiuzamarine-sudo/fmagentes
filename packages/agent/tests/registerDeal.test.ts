import { describe, expect, it } from "vitest";
import { registerDeal } from "../src/tools/registerDeal";
import { CrmNotInScopeError, type CrmScope } from "../src/crm/CrmPort";
import { createFakeCrm } from "./support/fakeCrm";

const SCOPE: CrmScope = { clientId: "crm-1", verified: true, conversationId: "conv-1" };
const VESSEL_ID = "0b6f1c1e-3a4d-4c5e-8f90-123456789abc";
const NOT_FOUND = "Erro: registro não encontrado. Não cite este erro ao cliente; continue o atendimento.";

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
    const answer = await registerDeal(crm, SCOPE, { funil: "vendas", titulo: "Compra", marca: "Yamaha" });

    expect(crm.fillDeal).toHaveBeenCalledWith(SCOPE, "deal-1", { brand: "Yamaha" });
    expect(crm.createDeal).not.toHaveBeenCalled();
    expect(answer).toBe("Negócio já aberto neste funil foi atualizado (negocio_id: deal-1).");
  });

  it("appends conflicts by label, never the values", async () => {
    const crm = createFakeCrm();
    crm.findOpenDeal.mockResolvedValue({ id: "deal-1" });
    crm.fillDeal.mockResolvedValue({ filled: [], conflicts: ["brand"] });
    const answer = await registerDeal(crm, SCOPE, { funil: "vendas", titulo: "x", marca: "Segredo" });
    expect(answer).toBe(
      "Negócio já aberto neste funil foi atualizado (negocio_id: deal-1). Já havia outro valor salvo para: Marca; a equipe vai conferir.",
    );
    expect(answer).not.toContain("Segredo");
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

  it("turns an out-of-scope vessel into the neutral error", async () => {
    const crm = createFakeCrm();
    crm.createDeal.mockRejectedValue(new CrmNotInScopeError());
    expect(await registerDeal(crm, SCOPE, { funil: "manutencao", titulo: "x", embarcacao_id: VESSEL_ID })).toBe(NOT_FOUND);
  });

  it("rejects a malformed embarcacao_id without calling the CRM", async () => {
    const crm = createFakeCrm();
    expect(await registerDeal(crm, SCOPE, { funil: "manutencao", titulo: "x", embarcacao_id: "not-a-uuid" })).toBe(NOT_FOUND);
    expect(crm.findOpenDeal).not.toHaveBeenCalled();
    expect(crm.createDeal).not.toHaveBeenCalled();
  });

  it("rethrows other CRM errors", async () => {
    const crm = createFakeCrm();
    crm.findOpenDeal.mockRejectedValue(new Error("kept changing"));
    await expect(registerDeal(crm, SCOPE, { funil: "pecas", titulo: "x" })).rejects.toThrow("kept changing");
  });
});
