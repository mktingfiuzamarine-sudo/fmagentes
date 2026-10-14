import { tool } from "ai";
import { z } from "zod";
import type { LinkedCustomer } from "@fmagentes/messaging";
import { isValidCpf, normalizeCpf } from "../cpf";
import { CrmCpfTakenError, type CrmPort } from "../crm/CrmPort";

export const REGISTER_TOOL_NAME = "cadastrar_cliente";

/** Filled by the tool during the call; the responder reports it to messaging. */
export interface RegistrationOutcome {
  linked?: LinkedCustomer;
}

export interface RegistrationArgs {
  nome: string;
  cpf: string;
  email: string;
}

const emailSchema = z.string().email();

/**
 * Validates, then links an existing CPF or creates the client. Invalid input
 * returns an error string so the model asks the customer again. A CPF link
 * returns no stored data: anyone can type someone else's CPF.
 */
export async function registerCustomer(
  crm: CrmPort,
  contactPhone: string,
  args: RegistrationArgs,
  outcome: RegistrationOutcome,
): Promise<string> {
  const name = args.nome.trim();
  if (name.length === 0) return "Erro: nome vazio. Peça o nome completo ao cliente.";
  if (!isValidCpf(args.cpf)) return "Erro: CPF inválido. Peça ao cliente para conferir e enviar o CPF novamente.";
  const email = args.email.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) {
    return "Erro: e-mail inválido. Peça ao cliente para conferir e enviar o e-mail novamente.";
  }
  const cpf = normalizeCpf(args.cpf);

  const link = async (clientId: string) => {
    await crm.attachPhone(clientId, contactPhone);
    outcome.linked = { crmClientId: clientId, via: "cpf" };
    return "Cadastro vinculado: este CPF já tinha cadastro. Continue o atendimento sem citar dados do cadastro.";
  };

  const existing = await crm.findByCpf(cpf);
  if (existing) return link(existing.id);

  try {
    const created = await crm.create({ name, cpf, email, phone: contactPhone });
    outcome.linked = { crmClientId: created.id, via: "created" };
    return "Cadastro criado com sucesso.";
  } catch (error) {
    if (!(error instanceof CrmCpfTakenError)) throw error;
    // Someone registered this CPF between our lookup and our insert.
    const raced = await crm.findByCpf(cpf);
    if (!raced) throw error;
    return link(raced.id);
  }
}

export function createRegisterCustomerTool(crm: CrmPort, contactPhone: string, outcome: RegistrationOutcome) {
  return tool({
    description:
      "Cadastra o cliente no CRM. Chame somente quando tiver nome completo, CPF e e-mail informados pelo cliente.",
    parameters: z.object({
      nome: z.string().describe("Nome completo do cliente"),
      cpf: z.string().describe("CPF do cliente, com ou sem pontuação"),
      email: z.string().describe("E-mail do cliente"),
    }),
    execute: (args) => registerCustomer(crm, contactPhone, args, outcome),
  });
}
