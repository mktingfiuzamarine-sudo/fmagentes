import { tool } from "ai";
import { z } from "zod";
import { CLIENT_FIELD_LABELS, LEAD_SOURCE_IDS } from "../crm/catalog";
import type { ClientFields, CrmPort, CrmScope } from "../crm/CrmPort";
import { FieldGuard, NOTHING_TO_SAVE_ANSWER, orNotFound, savedAnswer, text } from "./crmAnswers";

const emailSchema = z.string().email();
const MIN_LANDLINE_DIGITS = 8;

export const UPDATE_CUSTOMER_TOOL_NAME = "atualizar_cliente";

const BIRTHDAY_INVALID = " Data de aniversário inválida, não foi salva.";

export interface UpdateCustomerArgs {
  email?: string;
  telefone_fixo?: string;
  aniversario?: string;
  origem?: (typeof LEAD_SOURCE_IDS)[number];
  quem_indicou?: string;
  empresa?: string;
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Fills only empty client fields. The answer never contains stored data. */
export async function updateCustomer(crm: CrmPort, scope: CrmScope, args: UpdateCustomerArgs): Promise<string> {
  const fields: ClientFields = {};
  const put = (key: keyof ClientFields, value: string | undefined) => {
    if (value !== undefined) fields[key] = value;
  };
  const guard = new FieldGuard(CLIENT_FIELD_LABELS);
  put("email", guard.text("email", args.email, (v) => emailSchema.safeParse(v).success));
  put("landline", guard.text("landline", args.telefone_fixo, (v) => v.replace(/\D/g, "").length >= MIN_LANDLINE_DIGITS));
  put("lead_source", args.origem);
  put("referred_by", text(args.quem_indicou));
  put("company", text(args.empresa));

  let note = guard.suffix();
  const birthday = text(args.aniversario);
  if (birthday !== undefined) {
    if (isRealDate(birthday)) fields.birthday = birthday;
    else note += BIRTHDAY_INVALID;
  }

  if (Object.keys(fields).length === 0) return `${NOTHING_TO_SAVE_ANSWER}${note}`;
  return orNotFound(async () => `${savedAnswer(await crm.fillClient(scope, fields), CLIENT_FIELD_LABELS)}${note}`);
}

export function createUpdateCustomerTool(crm: CrmPort, scope: CrmScope) {
  return tool({
    description: "Grava na ficha do cliente dados que ele mencionou. Só preenche campos vazios; nunca apaga o que já existe.",
    parameters: z.object({
      email: z.string().optional().describe("E-mail do cliente"),
      telefone_fixo: z.string().optional().describe("Telefone fixo do cliente"),
      aniversario: z.string().optional().describe("Data de aniversário no formato AAAA-MM-DD"),
      origem: z.enum(LEAD_SOURCE_IDS).optional().describe("Como o cliente conheceu a Fiuza Marine"),
      quem_indicou: z.string().optional().describe("Nome de quem indicou o cliente (junto com origem indicacao)"),
      empresa: z.string().optional().describe("Empresa do cliente"),
    }),
    execute: (args) => updateCustomer(crm, scope, args),
  });
}
