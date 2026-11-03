import { tool } from "ai";
import { z } from "zod";
import { AGENT_DEAL_FIELDS, DEAL_FIELD_LABELS, PIPELINE_IDS, VESSEL_KIND_IDS, type PipelineId } from "../crm/catalog";
import type { CrmPort, CrmScope, DealFields } from "../crm/CrmPort";
import { NOT_FOUND_ANSWER, finiteNumber, isUuid, orNotFound, savedAnswer, text } from "./crmAnswers";

export const REGISTER_DEAL_TOOL_NAME = "registrar_negocio";

export interface RegisterDealArgs {
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

/** Opens the customer's deal in the pipeline, or completes the one already open there. */
export async function registerDeal(crm: CrmPort, scope: CrmScope, args: RegisterDealArgs): Promise<string> {
  const vesselId = text(args.embarcacao_id);
  if (vesselId !== undefined && !isUuid(vesselId)) return NOT_FOUND_ANSWER;

  const candidate: Record<string, string | number | undefined> = {
    product_type: args.tipo_produto,
    brand: text(args.marca),
    model: text(args.modelo),
    year: finiteNumber(args.ano),
    administrator: text(args.administradora),
    part_description: text(args.descricao_peca),
    vessel_id: vesselId,
    service_description: text(args.descricao_servico),
  };
  const fields: Record<string, string | number> = {};
  for (const key of AGENT_DEAL_FIELDS[args.funil] as readonly string[]) {
    const value = candidate[key];
    if (value !== undefined) fields[key] = value;
  }
  const dealFields = fields as DealFields;

  return orNotFound(async () => {
    const open = await crm.findOpenDeal(scope, args.funil);
    if (open) {
      const result = await crm.fillDeal(scope, open.id, dealFields);
      const base = `Negócio já aberto neste funil foi atualizado (negocio_id: ${open.id}).`;
      return result.conflicts.length === 0
        ? base
        : `${base}${savedAnswer(result, DEAL_FIELD_LABELS).slice("Salvo.".length)}`;
    }
    const title = text(args.titulo) ?? "Novo negócio";
    const created = await crm.createDeal(scope, args.funil, title, dealFields);
    return `Negócio aberto (negocio_id: ${created.id}).`;
  });
}

export function createRegisterDealTool(crm: CrmPort, scope: CrmScope) {
  return tool({
    description: "Abre ou completa o negócio do cliente no funil do assunto. Nunca informe valores.",
    parameters: z.object({
      funil: z.enum(PIPELINE_IDS).describe("vendas, consorcios, pecas ou manutencao"),
      titulo: z.string().describe("Título curto do negócio, ex.: Revisão Mercury 150 HP, Compra jet ski"),
      tipo_produto: z.enum(VESSEL_KIND_IDS).optional().describe("Só vendas: tipo de produto"),
      marca: z.string().optional().describe("Só vendas: marca"),
      modelo: z.string().optional().describe("Só vendas: modelo"),
      ano: z.number().optional().describe("Só vendas: ano"),
      administradora: z.string().optional().describe("Só consorcios: administradora"),
      descricao_peca: z.string().optional().describe("Só pecas: descrição da peça"),
      embarcacao_id: z.string().optional().describe("Só manutencao: id da embarcação ou motor registrado"),
      descricao_servico: z.string().optional().describe("Só manutencao: descrição do serviço"),
    }),
    execute: (args) => registerDeal(crm, scope, args),
  });
}
