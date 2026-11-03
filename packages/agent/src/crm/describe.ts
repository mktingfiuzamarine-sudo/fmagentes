import {
  HULL_TYPE_LABELS,
  JET_SKI_BRAND_LABELS,
  OUTBOARD_BRAND_LABELS,
  VESSEL_KIND_LABELS,
  type VesselFieldId,
  type VesselKind,
} from "./catalog";

export type VesselRow = { kind: VesselKind } & Partial<Record<VesselFieldId, string | number | null>>;

/** Engines per boat for each `engine_count` id. */
const ENGINE_MULTIPLIER: Record<string, number> = { unico: 1, parelha: 2, trelha: 3 };

const present = (v: unknown): v is string | number =>
  v !== null && v !== undefined && String(v).trim() !== "";

function labelOf(labels: Record<string, string>, id: unknown): string | undefined {
  if (!present(id)) return undefined;
  return labels[String(id)] ?? String(id);
}

const joined = (parts: unknown[], separator: string) => parts.filter(present).map(String).join(separator);

/** One line in pt-BR for a vessel, e.g. "Barco/Lancha · Fibra mono casco · 2018 · 2×150 HP". */
export function describeVessel(row: VesselRow): string {
  const kind = VESSEL_KIND_LABELS[row.kind] ?? row.kind;
  switch (row.kind) {
    case "barco_lancha": {
      const count = present(row.engine_count) ? ENGINE_MULTIPLIER[String(row.engine_count)] : undefined;
      const engines = present(row.horsepower) ? `${count ? `${count}×` : ""}${row.horsepower} HP` : undefined;
      return joined([kind, labelOf(HULL_TYPE_LABELS, row.hull_type), row.boat_year, engines], " · ");
    }
    case "motor_popa": {
      const hp = present(row.horsepower) ? `${row.horsepower} HP` : undefined;
      return joined([kind, joined([labelOf(OUTBOARD_BRAND_LABELS, row.brand), hp], " "), row.year], " · ");
    }
    case "jet_ski":
      return joined([kind, joined([labelOf(JET_SKI_BRAND_LABELS, row.brand), row.model], " "), row.year], " · ");
    default:
      return kind;
  }
}
