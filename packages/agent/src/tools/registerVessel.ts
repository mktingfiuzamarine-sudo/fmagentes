import { tool } from "ai";
import { z } from "zod";
import {
  ENGINE_COUNT_IDS,
  ENGINE_TYPE_IDS,
  HULL_TYPE_IDS,
  JET_SKI_BRAND_IDS,
  OUTBOARD_BRAND_IDS,
  VESSEL_FIELD_LABELS,
  VESSEL_KIND_IDS,
  type VesselKind,
} from "../crm/catalog";
import { CrmVesselKindMismatchError, type CrmPort, type CrmScope, type VesselFields } from "../crm/CrmPort";
import { NOT_FOUND_ANSWER, NOTHING_TO_SAVE_ANSWER, finiteNumber, isUuid, orNotFound, savedAnswer, text } from "./crmAnswers";

export const REGISTER_VESSEL_TOOL_NAME = "registrar_embarcacao";

const OTHER_KIND_ANSWER = "Erro: essa embarcação é de outro tipo. Registre uma nova.";
const MAX_BRAND_NOTE = 200;

export interface RegisterVesselArgs {
  embarcacao_id?: string;
  tipo: VesselKind;
  tipo_casco?: (typeof HULL_TYPE_IDS)[number];
  estaleiro?: string;
  tamanho_metros?: number;
  tamanho_pes?: number;
  ano_barco?: number;
  quantidade_motores?: (typeof ENGINE_COUNT_IDS)[number];
  tipo_motor?: (typeof ENGINE_TYPE_IDS)[number];
  marca_motor?: string;
  potencia_hp?: number;
  ano_motor?: number;
  marca?: string;
  modelo?: string;
  ano?: number;
}

const BRANDS: Partial<Record<VesselKind, readonly string[]>> = {
  motor_popa: OUTBOARD_BRAND_IDS,
  jet_ski: JET_SKI_BRAND_IDS,
};

const squash = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");

/** Brand id when the text matches the kind's list (case, spaces and hyphens ignored). */
function matchBrand(kind: VesselKind, raw: string): string | undefined {
  const wanted = squash(raw);
  return BRANDS[kind]?.find((id) => squash(id) === wanted);
}

/** Only the fields that belong to the chosen kind; the rest is dropped silently. */
function fieldsFor(args: RegisterVesselArgs): { fields: VesselFields; unlistedBrand?: string } {
  const fields: VesselFields = {};
  const put = (key: keyof VesselFields, value: string | number | undefined) => {
    if (value !== undefined) (fields as Record<string, string | number>)[key] = value;
  };
  let unlistedBrand: string | undefined;

  if (args.tipo === "barco_lancha") {
    put("hull_type", args.tipo_casco);
    put("builder", text(args.estaleiro));
    put("length_m", finiteNumber(args.tamanho_metros));
    put("length_ft", finiteNumber(args.tamanho_pes));
    put("boat_year", finiteNumber(args.ano_barco));
    put("engine_count", args.quantidade_motores);
    put("engine_type", args.tipo_motor);
    put("engine_brand", text(args.marca_motor));
    put("horsepower", finiteNumber(args.potencia_hp));
    put("engine_year", finiteNumber(args.ano_motor));
    return { fields };
  }

  const brand = text(args.marca);
  if (brand !== undefined) {
    const id = matchBrand(args.tipo, brand);
    if (id) put("brand", id);
    else unlistedBrand = brand;
  }
  put("model", text(args.modelo));
  put("year", finiteNumber(args.ano));
  if (args.tipo === "motor_popa") put("horsepower", finiteNumber(args.potencia_hp));
  return { fields, unlistedBrand };
}

function brandNote(brand: string): string {
  const oneLine = brand.replace(/\s+/g, " ").trim().slice(0, MAX_BRAND_NOTE).trim();
  return `Marca informada: ${oneLine}`;
}

/** Registers a vessel the customer already owns, or completes one already registered. */
export async function registerVessel(crm: CrmPort, scope: CrmScope, args: RegisterVesselArgs): Promise<string> {
  const vesselId = text(args.embarcacao_id);
  if (vesselId !== undefined && !isUuid(vesselId)) return NOT_FOUND_ANSWER;

  const { fields, unlistedBrand } = fieldsFor(args);

  if (vesselId !== undefined) {
    // fillVessel takes no notes: an unlisted brand is dropped when completing.
    if (Object.keys(fields).length === 0) return NOTHING_TO_SAVE_ANSWER;
    return orNotFound(async () => {
      try {
        return savedAnswer(await crm.fillVessel(scope, vesselId, fields, args.tipo), VESSEL_FIELD_LABELS);
      } catch (error) {
        if (error instanceof CrmVesselKindMismatchError) return OTHER_KIND_ANSWER;
        throw error;
      }
    });
  }

  return orNotFound(async () => {
    const created = await crm.createVessel(scope, args.tipo, {
      ...fields,
      ...(unlistedBrand !== undefined ? { notes: brandNote(unlistedBrand) } : {}),
    });
    return `Embarcação registrada (embarcacao_id: ${created.id}).`;
  });
}

export function createRegisterVesselTool(crm: CrmPort, scope: CrmScope) {
  return tool({
    description:
      "Registra uma embarcação ou motor que o cliente JÁ TEM (não o que quer comprar). Use embarcacao_id para completar uma já registrada.",
    parameters: z.object({
      embarcacao_id: z.string().optional().describe("Id de uma embarcação já registrada, para completar os dados dela"),
      tipo: z.enum(VESSEL_KIND_IDS).describe("barco_lancha, jet_ski ou motor_popa"),
      tipo_casco: z.enum(HULL_TYPE_IDS).optional().describe("Só barco_lancha: tipo de casco"),
      estaleiro: z.string().optional().describe("Só barco_lancha: estaleiro ou marca do barco"),
      tamanho_metros: z.number().optional().describe("Só barco_lancha: tamanho em metros"),
      tamanho_pes: z.number().optional().describe("Só barco_lancha: tamanho em pés"),
      ano_barco: z.number().optional().describe("Só barco_lancha: ano do barco"),
      quantidade_motores: z.enum(ENGINE_COUNT_IDS).optional().describe("Só barco_lancha: unico, parelha (2) ou trelha (3)"),
      tipo_motor: z.enum(ENGINE_TYPE_IDS).optional().describe("Só barco_lancha: motor de popa ou de centro"),
      marca_motor: z.string().optional().describe("Só barco_lancha: marca do motor"),
      potencia_hp: z.number().optional().describe("Barco_lancha ou motor_popa: potência em HP"),
      ano_motor: z.number().optional().describe("Só barco_lancha: ano do motor"),
      marca: z.string().optional().describe("Só motor_popa e jet_ski: marca"),
      modelo: z.string().optional().describe("Só motor_popa e jet_ski: modelo"),
      ano: z.number().optional().describe("Só motor_popa e jet_ski: ano de fabricação"),
    }),
    execute: (args) => registerVessel(crm, scope, args),
  });
}
