/** Catálogo de ids e rótulos do CRM Fiuza Marine (espelha os CHECKs do banco do CRM). */

export const PIPELINE_IDS = ["vendas", "consorcios", "pecas", "manutencao"] as const;
export type PipelineId = (typeof PIPELINE_IDS)[number];

export const PIPELINE_LABELS: Record<PipelineId, string> = {
  vendas: "Vendas",
  consorcios: "Consórcios",
  pecas: "Peças e Acessórios",
  manutencao: "Serviços de Manutenção",
};

export const STAGES: Record<PipelineId, readonly { id: string; label: string }[]> = {
  vendas: [
    { id: "lead", label: "Lead" },
    { id: "visita", label: "Visita" },
    { id: "proposta", label: "Proposta" },
    { id: "negociacao", label: "Negociação" },
    { id: "fechado", label: "Fechado" },
  ],
  consorcios: [
    { id: "lead", label: "Lead" },
    { id: "documentacao", label: "Documentação" },
    { id: "contrato_assinado", label: "Contrato Assinado" },
    { id: "contemplado", label: "Contemplado" },
    { id: "encerrado", label: "Encerrado" },
  ],
  pecas: [
    { id: "lead", label: "Lead" },
    { id: "orcamento", label: "Orçamento" },
    { id: "pedido_confirmado", label: "Pedido Confirmado" },
    { id: "entregue", label: "Entregue" },
  ],
  manutencao: [
    { id: "orcamento_solicitado", label: "Orçamento Solicitado" },
    { id: "aprovado", label: "Aprovado" },
    { id: "em_execucao", label: "Em Execução" },
    { id: "entregue", label: "Entregue" },
    { id: "pago", label: "Pago" },
  ],
};

/** Id da última etapa do funil. */
export function lastStage(p: PipelineId): string {
  const stages = STAGES[p];
  return stages[stages.length - 1].id;
}

export const LEAD_SOURCE_IDS = [
  "instagram",
  "facebook",
  "indicacao",
  "google_meu_negocio",
  "site",
  "lpage_motores",
  "lpage_servicos",
  "outros",
] as const;
export type LeadSource = (typeof LEAD_SOURCE_IDS)[number];

export const VESSEL_KIND_IDS = ["barco_lancha", "jet_ski", "motor_popa"] as const;
export type VesselKind = (typeof VESSEL_KIND_IDS)[number];

export const HULL_TYPE_IDS = ["aluminio_mono", "fibra_mono", "catamara", "outro"] as const;
export const ENGINE_COUNT_IDS = ["unico", "parelha", "trelha"] as const;
export const ENGINE_TYPE_IDS = ["popa", "centro"] as const;
export const OUTBOARD_BRAND_IDS = [
  "yamaha",
  "evinrude",
  "johnson",
  "mercury",
  "suzuki",
  "hidea",
  "tohatsu",
  "honda",
] as const;
export const JET_SKI_BRAND_IDS = ["sea_doo", "yamaha", "kawasaki", "honda"] as const;

export const CLIENT_FIELD_LABELS: Record<string, string> = {
  email: "E-mail",
  landline: "Telefone fixo",
  birthday: "Aniversário",
  lead_source: "Origem do lead",
  referred_by: "Quem indicou",
  company: "Empresa",
};

export const VESSEL_FIELD_LABELS = {
  hull_type: "Tipo de casco",
  builder: "Estaleiro/marca",
  length_m: "Tamanho (m)",
  length_ft: "Tamanho (pés)",
  boat_year: "Ano do barco",
  engine_count: "Quantidade de motores",
  engine_type: "Tipo de motor",
  engine_brand: "Marca do motor",
  horsepower: "Potência (HP)",
  engine_year: "Ano do motor",
  brand: "Marca",
  model: "Modelo",
  year: "Ano de fabricação",
  notes: "Observações",
} as const satisfies Record<string, string>;

/** Colunas de embarcação que a IA pode preencher (tudo menos `notes`). */
export type VesselFieldId = Exclude<keyof typeof VESSEL_FIELD_LABELS, "notes">;

export const DEAL_FIELD_LABELS: Record<string, string> = {
  product_type: "Tipo de produto",
  brand: "Marca",
  model: "Modelo",
  year: "Ano",
  olist_proposal_number: "Nº da proposta (Olist)",
  olist_sales_order_number: "Nº do pedido de venda (Olist)",
  consortium_value: "Valor do consórcio",
  administrator: "Administradora",
  contract_number: "Número do contrato",
  part_description: "Descrição da peça",
  vessel_id: "Embarcação/motor",
  service_description: "Descrição do serviço",
  olist_service_order_number: "Nº da OS (Olist)",
};

/** Campos do negócio que a IA pode preencher, por funil. */
export const AGENT_DEAL_FIELDS = {
  vendas: ["product_type", "brand", "model", "year"],
  consorcios: ["administrator"],
  pecas: ["part_description"],
  manutencao: ["vessel_id", "service_description"],
} as const satisfies Record<PipelineId, readonly string[]>;

export type AgentDealFieldId = (typeof AGENT_DEAL_FIELDS)[PipelineId][number];

export const VESSEL_KIND_LABELS: Record<VesselKind, string> = {
  barco_lancha: "Barco/Lancha",
  jet_ski: "Jet Ski",
  motor_popa: "Motor de Popa",
};

export const HULL_TYPE_LABELS: Record<(typeof HULL_TYPE_IDS)[number], string> = {
  aluminio_mono: "Alumínio mono casco",
  fibra_mono: "Fibra mono casco",
  catamara: "Catamarã",
  outro: "Outro",
};

export const OUTBOARD_BRAND_LABELS: Record<(typeof OUTBOARD_BRAND_IDS)[number], string> = {
  yamaha: "Yamaha",
  evinrude: "Evinrude",
  johnson: "Johnson",
  mercury: "Mercury",
  suzuki: "Suzuki",
  hidea: "Hidea",
  tohatsu: "Tohatsu",
  honda: "Honda",
};

export const JET_SKI_BRAND_LABELS: Record<(typeof JET_SKI_BRAND_IDS)[number], string> = {
  sea_doo: "Sea-Doo",
  yamaha: "Yamaha",
  kawasaki: "Kawasaki",
  honda: "Honda",
};
