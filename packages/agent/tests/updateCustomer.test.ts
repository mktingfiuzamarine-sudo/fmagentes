import { describe, expect, it } from "vitest";
import { updateCustomer } from "../src/tools/updateCustomer";
import { CrmNotInScopeError, type CrmScope } from "../src/crm/CrmPort";
import { createFakeCrm } from "./support/fakeCrm";

const SCOPE: CrmScope = { clientId: "crm-1", verified: true, conversationId: "conv-1" };

describe("updateCustomer", () => {
  it("maps the arguments to client columns", async () => {
    const crm = createFakeCrm();
    crm.fillClient.mockResolvedValue({ filled: ["landline", "lead_source"], conflicts: [] });

    const answer = await updateCustomer(crm, SCOPE, { telefone_fixo: " 1133334444 ", origem: "instagram" });

    expect(crm.fillClient).toHaveBeenCalledWith(SCOPE, { landline: "1133334444", lead_source: "instagram" });
    expect(answer).toBe("Salvo.");
  });

  it("names conflicting fields by label, never the stored values", async () => {
    const crm = createFakeCrm();
    const STORED = "guardado@stored.example";
    crm.findById.mockResolvedValue({ id: "crm-1", name: "Ana Souza", phone: "11999990000", notes: STORED });
    crm.fillClient.mockResolvedValue({ filled: [], conflicts: ["email"] });

    const answer = await updateCustomer(crm, SCOPE, { email: "novo@example.com" });

    expect(answer).toBe("Salvo. Já havia outro valor salvo para: E-mail; a equipe vai conferir.");
    expect(answer).not.toContain(STORED);
    expect(answer).not.toContain("Ana Souza");
  });

  it("discards an impossible birthday and says so", async () => {
    const crm = createFakeCrm();
    const answer = await updateCustomer(crm, SCOPE, { aniversario: "2026-02-30" });
    expect(crm.fillClient).not.toHaveBeenCalled();
    expect(answer).toBe("Nada novo para salvar. Data de aniversário inválida, não foi salva.");
  });

  it("keeps the other fields when the birthday is invalid", async () => {
    const crm = createFakeCrm();
    const answer = await updateCustomer(crm, SCOPE, { aniversario: "10/02/1990", empresa: "Acme" });
    expect(crm.fillClient).toHaveBeenCalledWith(SCOPE, { company: "Acme" });
    expect(answer).toBe("Salvo. Data de aniversário inválida, não foi salva.");
  });

  it("accepts a valid birthday", async () => {
    const crm = createFakeCrm();
    await updateCustomer(crm, SCOPE, { aniversario: "1990-02-10" });
    expect(crm.fillClient).toHaveBeenCalledWith(SCOPE, { birthday: "1990-02-10" });
  });

  it("discards an invalid e-mail or landline and says so", async () => {
    const crm = createFakeCrm();
    const answer = await updateCustomer(crm, SCOPE, { email: "não tenho", telefone_fixo: "123", empresa: "Acme" });
    expect(crm.fillClient).toHaveBeenCalledWith(SCOPE, { company: "Acme" });
    expect(answer).toBe("Salvo. Não salvo por estar fora do esperado: E-mail, Telefone fixo.");
  });

  it("has nothing to save when every field is blank", async () => {
    const crm = createFakeCrm();
    expect(await updateCustomer(crm, SCOPE, { email: "  " })).toBe("Nada novo para salvar.");
    expect(crm.fillClient).not.toHaveBeenCalled();
  });

  it("turns an out-of-scope client into the neutral error", async () => {
    const crm = createFakeCrm();
    crm.fillClient.mockRejectedValue(new CrmNotInScopeError());
    expect(await updateCustomer(crm, SCOPE, { empresa: "Acme" })).toBe(
      "Erro: registro não encontrado. Não cite este erro ao cliente; continue o atendimento.",
    );
  });

  it("rethrows other CRM errors so the job retries", async () => {
    const crm = createFakeCrm();
    crm.fillClient.mockRejectedValue(new Error("db down"));
    await expect(updateCustomer(crm, SCOPE, { empresa: "Acme" })).rejects.toThrow("db down");
  });
});
