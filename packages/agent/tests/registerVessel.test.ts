import { describe, expect, it } from "vitest";
import { registerVessel } from "../src/tools/registerVessel";
import { CrmNotInScopeError, CrmVesselKindMismatchError, type CrmScope } from "../src/crm/CrmPort";
import { createFakeCrm } from "./support/fakeCrm";

const SCOPE: CrmScope = { clientId: "crm-1", verified: true, conversationId: "conv-1" };
const VESSEL_ID = "0b6f1c1e-3a4d-4c5e-8f90-123456789abc";
const NOT_FOUND = "Erro: registro não encontrado. Não cite este erro ao cliente; continue o atendimento.";

describe("registerVessel", () => {
  it("creates with the kind and mapped columns, and returns the id", async () => {
    const crm = createFakeCrm();
    const answer = await registerVessel(crm, SCOPE, {
      tipo: "barco_lancha",
      tamanho_metros: 8.5,
      potencia_hp: 150,
      tipo_casco: "fibra_mono",
      marca_motor: "Mercury",
    });

    expect(crm.createVessel).toHaveBeenCalledWith(SCOPE, "barco_lancha", {
      length_m: 8.5,
      horsepower: 150,
      hull_type: "fibra_mono",
      engine_brand: "Mercury",
    });
    expect(answer).toBe("Embarcação registrada (embarcacao_id: vessel-new).");
  });

  it("drops params that do not belong to the kind", async () => {
    const crm = createFakeCrm();
    await registerVessel(crm, SCOPE, {
      tipo: "jet_ski",
      marca: "Sea Doo",
      modelo: "GTI",
      ano: 2020,
      potencia_hp: 130,
      estaleiro: "X",
    });
    expect(crm.createVessel).toHaveBeenCalledWith(SCOPE, "jet_ski", { brand: "sea_doo", model: "GTI", year: 2020 });
  });

  it("matches an id-style brand such as sea_doo", async () => {
    const crm = createFakeCrm();
    await registerVessel(crm, SCOPE, { tipo: "jet_ski", marca: "sea_doo" });
    expect(crm.createVessel).toHaveBeenCalledWith(SCOPE, "jet_ski", { brand: "sea_doo" });
  });

  it("never reveals stored data in its answers", async () => {
    const crm = createFakeCrm();
    const STORED = "Mercury-SEGREDO-999";
    crm.loadSnapshot.mockResolvedValue({
      missingClientFields: [],
      vessels: [{ id: VESSEL_ID, kind: "motor_popa", summary: STORED }],
      openDeals: [],
    });
    crm.fillVessel.mockResolvedValue({ filled: [], conflicts: ["brand", "horsepower"], kind: "motor_popa" });
    const answers = [
      await registerVessel(crm, SCOPE, { tipo: "motor_popa", embarcacao_id: VESSEL_ID, marca: "Yamaha", potencia_hp: 90 }),
      await registerVessel(crm, SCOPE, { tipo: "motor_popa", marca: "Yamaha" }),
    ];
    for (const answer of answers) expect(answer).not.toContain(STORED);
  });

  it("matches the brand ignoring case, spaces and hyphens", async () => {
    const crm = createFakeCrm();
    await registerVessel(crm, SCOPE, { tipo: "motor_popa", marca: " MERCURY ", potencia_hp: 150 });
    expect(crm.createVessel).toHaveBeenCalledWith(SCOPE, "motor_popa", { brand: "mercury", horsepower: 150 });
  });

  it("sends an unlisted brand as a one-line note on create", async () => {
    const crm = createFakeCrm();
    await registerVessel(crm, SCOPE, { tipo: "jet_ski", marca: "Mercury\nBlah" });
    expect(crm.createVessel).toHaveBeenCalledWith(SCOPE, "jet_ski", { notes: "Marca informada: Mercury Blah" });
  });

  it("truncates a long unlisted brand", async () => {
    const crm = createFakeCrm();
    await registerVessel(crm, SCOPE, { tipo: "jet_ski", marca: "x".repeat(500) });
    expect(crm.createVessel.mock.calls[0][2].notes).toBe(`Marca informada: ${"x".repeat(200)}`);
  });

  it("completes an existing vessel with fillVessel and notes an unlisted brand", async () => {
    const crm = createFakeCrm();
    crm.fillVessel.mockResolvedValue({ filled: ["model"], conflicts: [], kind: "jet_ski" });
    const answer = await registerVessel(crm, SCOPE, {
      tipo: "jet_ski",
      embarcacao_id: VESSEL_ID,
      marca: "Mercury",
      modelo: "GTI",
    });

    expect(crm.fillVessel).toHaveBeenCalledWith(SCOPE, VESSEL_ID, { model: "GTI" }, "jet_ski", "Marca informada: Mercury");
    expect(crm.createVessel).not.toHaveBeenCalled();
    expect(answer).toBe("Salvo.");
  });

  it("reports conflicts by label", async () => {
    const crm = createFakeCrm();
    crm.fillVessel.mockResolvedValue({ filled: [], conflicts: ["horsepower"], kind: "motor_popa" });
    expect(await registerVessel(crm, SCOPE, { tipo: "motor_popa", embarcacao_id: VESSEL_ID, potencia_hp: 90 })).toBe(
      "Salvo. Já havia outro valor salvo para: Potência (HP); a equipe vai conferir.",
    );
  });

  it("has nothing to save when completing with no usable field", async () => {
    const crm = createFakeCrm();
    expect(await registerVessel(crm, SCOPE, { tipo: "jet_ski", embarcacao_id: VESSEL_ID, potencia_hp: 90 })).toBe(
      "Nada novo para salvar.",
    );
    expect(crm.fillVessel).not.toHaveBeenCalled();
  });

  it("drops years outside 1900-2100 and non-positive sizes, and says which", async () => {
    const crm = createFakeCrm();
    const answer = await registerVessel(crm, SCOPE, {
      tipo: "barco_lancha",
      ano_barco: 98,
      ano_motor: 2018.5,
      tamanho_metros: 0,
      potencia_hp: -5,
      tipo_casco: "fibra_mono",
    });
    expect(crm.createVessel).toHaveBeenCalledWith(SCOPE, "barco_lancha", { hull_type: "fibra_mono" });
    expect(answer).toBe(
      "Embarcação registrada (embarcacao_id: vessel-new). Não salvo por estar fora do esperado: Tamanho (m), Ano do barco, Potência (HP), Ano do motor.",
    );
  });

  it("keeps a valid year and size", async () => {
    const crm = createFakeCrm();
    await registerVessel(crm, SCOPE, { tipo: "jet_ski", ano: 2020 });
    await registerVessel(crm, SCOPE, { tipo: "barco_lancha", tamanho_pes: 26, ano_barco: 1900 });
    expect(crm.createVessel).toHaveBeenNthCalledWith(1, SCOPE, "jet_ski", { year: 2020 });
    expect(crm.createVessel).toHaveBeenNthCalledWith(2, SCOPE, "barco_lancha", { length_ft: 26, boat_year: 1900 });
  });

  it("refuses a vessel of another kind", async () => {
    const crm = createFakeCrm();
    crm.fillVessel.mockRejectedValue(new CrmVesselKindMismatchError());
    expect(await registerVessel(crm, SCOPE, { tipo: "jet_ski", embarcacao_id: VESSEL_ID, modelo: "GTI" })).toBe(
      "Erro: essa embarcação é de outro tipo. Registre uma nova.",
    );
  });

  it("turns out-of-scope into the neutral error", async () => {
    const crm = createFakeCrm();
    crm.fillVessel.mockRejectedValue(new CrmNotInScopeError());
    expect(await registerVessel(crm, SCOPE, { tipo: "jet_ski", embarcacao_id: VESSEL_ID, modelo: "GTI" })).toBe(NOT_FOUND);
  });

  it("rejects a malformed embarcacao_id without calling the CRM", async () => {
    const crm = createFakeCrm();
    expect(await registerVessel(crm, SCOPE, { tipo: "jet_ski", embarcacao_id: "not-a-uuid", modelo: "GTI" })).toBe(NOT_FOUND);
    expect(crm.fillVessel).not.toHaveBeenCalled();
    expect(crm.createVessel).not.toHaveBeenCalled();
  });

  it("rethrows other CRM errors", async () => {
    const crm = createFakeCrm();
    crm.createVessel.mockRejectedValue(new Error("db down"));
    await expect(registerVessel(crm, SCOPE, { tipo: "jet_ski" })).rejects.toThrow("db down");
  });
});
