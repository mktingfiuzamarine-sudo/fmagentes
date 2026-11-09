import { tool } from "ai";
import { z } from "zod";
import { toolArgs } from "./toolArgs";
import { AGENT_DEAL_FIELDS, DEAL_FIELD_LABELS, PIPELINE_IDS, VESSEL_KIND_IDS, type PipelineId } from "../crm/catalog";
import { CrmNotInScopeError, type CrmPort, type CrmScope, type DealFields } from "../crm/CrmPort";
import { FieldGuard, NOTHING_TO_SAVE_ANSWER, isUuid, orNotFound, savedAnswer, text } from "./crmAnswers";

export const REGISTER_DEAL_TOOL_NAME = "registrar_negocio";

const MAX_TITLE = 120;
/** Same wording for an invented and an out-of-scope vessel: it reveals nothing about other customers. */
const UNKNOWN_VESSEL_NOTE =
  " A embarcação informada não existe e ficou de fora. Não invente embarcacao_id: pergunte ao cliente sobre o barco ou motor, registre com registrar_embarcacao e complete este negócio com o embarcacao_id devolvido.";

const NOT_OPEN_HERE_ANSWER =
  "Erro: esse negocio_id não é um negócio aberto deste funil. Use um negocio_id da lista Negócios abertos do mesmo funil, ou chame sem negocio_id para abrir um negócio novo.";

const squashTitle = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const sameTitle = (a: string, b: string) => squashTitle(a) === squashTitle(b);

export interface RegisterDealArgs {
  negocio_id?: string;
  funil: PipelineId;
  titulo: string;
  tipo_produto?: (typeof VESSEL_KIND_IDS)[number];
  marca?: string;
  modelo?: string;
  ano?: number;
  administradora?: string;
  descricao_peca?: string;
  embarcacao_id?: string;
  descricao_servico?: string;
}

/** Opens a deal in the pipeline, or completes the open one the model names (or one with the same title). */
export async function registerDeal(crm: CrmPort, scope: CrmScope, args: RegisterDealArgs): Promise<string> {
  const givenVesselId = text(args.embarcacao_id);
  // Models invent vessel ids: a malformed one is left out up front, like an unknown one below.
  let unknownVessel = givenVesselId !== undefined && !isUuid(givenVesselId);
  const vesselId = unknownVessel ? undefined : givenVesselId;

  const guard = new FieldGuard(DEAL_FIELD_LABELS);
  const allowed = AGENT_DEAL_FIELDS[args.funil] as readonly string[];
  const candidate: Record<string, string | number | undefined> = {
    product_type: args.tipo_produto,
    brand: text(args.marca),
    model: text(args.modelo),
    year: allowed.includes("year") ? guard.year("year", args.ano) : undefined,
    administrator: text(args.administradora),
    part_description: text(args.descricao_peca),
    vessel_id: vesselId,
    service_description: text(args.descricao_servico),
  };
  const fields: Record<string, string | number> = {};
  for (const key of allowed) {
    const value = candidate[key];
    if (value !== undefined) fields[key] = value;
  }
  const dealFields = fields as DealFields;
  const suffix = () => `${guard.suffix()}${unknownVessel ? UNKNOWN_VESSEL_NOTE : ""}`;

  // Comes from the customer's words: one line, capped, as it shows on the board and in the prompt.
  const title = (text(args.titulo) ?? "Novo negócio").replace(/\s+/g, " ").slice(0, MAX_TITLE).trim();
  const dealId = text(args.negocio_id);

  const save = async (toSave: DealFields): Promise<string> => {
    // A customer can have several open deals in one pipeline (a propeller and a mirror):
    // the model names the one to complete; without an id a new subject opens a new deal.
    const open = await crm.findOpenDeals(scope, args.funil);
    const target = dealId !== undefined
      ? open.find((deal) => deal.id === dealId)
      // Same title again (a retried job, the model repeating itself) completes it instead of duplicating.
      : open.find((deal) => sameTitle(deal.title, title));
    if (dealId !== undefined && !target) return NOT_OPEN_HERE_ANSWER;
    if (target) {
      const result = await crm.fillDeal(scope, target.id, toSave);
      if (result.filled.length === 0 && result.conflicts.length === 0) {
        return `Negócio já aberto (negocio_id: ${target.id}). ${NOTHING_TO_SAVE_ANSWER}${suffix()}`;
      }
      const base = `Negócio atualizado (negocio_id: ${target.id}).`;
      return `${base}${savedAnswer(result, DEAL_FIELD_LABELS).slice("Salvo.".length)}${suffix()}`;
    }
    const created = await crm.createDeal(scope, args.funil, title, toSave);
    return `Negócio aberto (negocio_id: ${created.id}).${suffix()}`;
  };

  return orNotFound(async () => {
    try {
      return await save(dealFields);
    } catch (error) {
      // The deal was found in scope (or is new), so a scope error here can only be the vessel,
      // refused before anything was written: save the rest without it.
      if (!(error instanceof CrmNotInScopeError) || dealFields.vessel_id === undefined) throw error;
      unknownVessel = true;
      const { vessel_id: _dropped, ...withoutVessel } = dealFields;
      return save(withoutVessel);
    }
  });
}

export function createRegisterDealTool(crm: CrmPort, scope: CrmScope) {
  return tool({
    description:
      "Abre um negócio novo no funil do assunto, ou completa um negócio já aberto quando você informa o negocio_id dele. Um assunto novo (outra peça, outro serviço, outra compra) é sempre um negócio novo: chame sem negocio_id. Nunca informe valores.",
    parameters: toolArgs({
      negocio_id: z
        .string()
        .optional()
        .describe("Só para completar um negócio da lista Negócios abertos do mesmo funil. Omita para abrir um negócio novo."),
      funil: z.enum(PIPELINE_IDS).describe("vendas, consorcios, pecas ou manutencao"),
      titulo: z.string().describe("Título curto do negócio, ex.: Revisão Mercury 150 HP, Compra jet ski"),
      tipo_produto: z.enum(VESSEL_KIND_IDS).optional().describe("Só vendas: tipo de produto"),
      marca: z.string().optional().describe("Só vendas: marca do que o cliente quer comprar (nunca do que ele já tem)"),
      modelo: z.string().optional().describe("Só vendas: modelo do que o cliente quer comprar"),
      ano: z.number().optional().describe("Só vendas: ano do que o cliente quer comprar"),
      administradora: z.string().optional().describe("Só consorcios: administradora"),
      descricao_peca: z.string().optional().describe("Só pecas: descrição da peça"),
      embarcacao_id: z.string().optional().describe("Só manutencao: id da embarcação ou motor registrado"),
      descricao_servico: z.string().optional().describe("Só manutencao: descrição do serviço"),
    }),
    execute: (args) => registerDeal(crm, scope, args),
  });
}
