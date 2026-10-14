import { describe, expect, it } from "vitest";
import { registerCustomer, type RegistrationOutcome } from "../src/tools/registerCustomer";
import { CrmCpfTakenError } from "../src/crm/CrmPort";
import { createFakeCrm } from "./support/fakeCrm";

const PHONE = "5511988887777";
const VALID = { nome: " Bruno Lima ", cpf: "529.982.247-25", email: " Bruno@Example.com " };
const EXISTING = { id: "crm-1", name: "Ana Souza", phone: "11 3333-4444", notes: "VIP, e-mail ana@example.com" };

describe("registerCustomer", () => {
  it.each([
    ["blank name", { ...VALID, nome: "  " }, /nome/i],
    ["invalid CPF", { ...VALID, cpf: "111.111.111-11" }, /CPF inválido/],
    ["invalid e-mail", { ...VALID, email: "bruno@" }, /e-mail inválido/],
  ])("rejects %s without touching the CRM", async (_label, args, message) => {
    const crm = createFakeCrm();
    const outcome: RegistrationOutcome = {};

    await expect(registerCustomer(crm, PHONE, args, outcome)).resolves.toMatch(message);
    expect(crm.findByCpf).not.toHaveBeenCalled();
    expect(crm.create).not.toHaveBeenCalled();
    expect(outcome.linked).toBeUndefined();
  });

  it("creates a new client with normalised data", async () => {
    const crm = createFakeCrm();
    const outcome: RegistrationOutcome = {};

    await expect(registerCustomer(crm, PHONE, VALID, outcome)).resolves.toMatch(/criado/i);
    expect(crm.findByCpf).toHaveBeenCalledWith("52998224725");
    expect(crm.create).toHaveBeenCalledWith({
      name: "Bruno Lima",
      cpf: "52998224725",
      email: "bruno@example.com",
      phone: PHONE,
    });
    expect(outcome.linked).toEqual({ crmClientId: "crm-new", via: "created" });
  });

  it("links an existing CPF, attaches the phone and reveals nothing stored", async () => {
    const crm = createFakeCrm({ byCpf: EXISTING });
    const outcome: RegistrationOutcome = {};

    const answer = await registerCustomer(crm, PHONE, VALID, outcome);

    expect(answer).toMatch(/vinculado/i);
    expect(answer).not.toContain("Ana");
    expect(answer).not.toContain("ana@example.com");
    expect(answer).not.toContain("3333");
    expect(crm.attachPhone).toHaveBeenCalledWith("crm-1", PHONE);
    expect(crm.create).not.toHaveBeenCalled();
    expect(outcome.linked).toEqual({ crmClientId: "crm-1", via: "cpf" });
  });

  it("links instead of failing when another process created the CPF first", async () => {
    const crm = createFakeCrm();
    crm.create.mockRejectedValueOnce(new CrmCpfTakenError());
    crm.findByCpf.mockResolvedValueOnce(null).mockResolvedValueOnce(EXISTING);
    const outcome: RegistrationOutcome = {};

    await expect(registerCustomer(crm, PHONE, VALID, outcome)).resolves.toMatch(/vinculado/i);
    expect(outcome.linked).toEqual({ crmClientId: "crm-1", via: "cpf" });
  });

  it("throws when the CRM is unavailable so the job retries", async () => {
    const crm = createFakeCrm();
    crm.findByCpf.mockRejectedValueOnce(new Error("crm down"));

    await expect(registerCustomer(crm, PHONE, VALID, {})).rejects.toThrow("crm down");
  });
});
