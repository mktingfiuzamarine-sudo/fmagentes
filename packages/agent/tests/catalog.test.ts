import { describe, expect, it } from "vitest";
import { AGENT_DEAL_FIELDS, STAGES, lastStage } from "../src/crm/catalog";

describe("catalog", () => {
  it("knows the last stage of each pipeline", () => {
    expect(lastStage("manutencao")).toBe("pago");
    expect(lastStage("vendas")).toBe("fechado");
  });

  it("lists the vendas stages in order", () => {
    expect(STAGES.vendas.map((s) => s.id)).toEqual(["lead", "visita", "proposta", "negociacao", "fechado"]);
  });

  it("never lets the agent fill staff-only deal fields", () => {
    const all = Object.values(AGENT_DEAL_FIELDS).flat();
    expect(all).not.toContain("consortium_value");
    expect(all).not.toContain("contract_number");
    expect(all.filter((f) => f.startsWith("olist_"))).toEqual([]);
  });
});

// compile-time check: VesselFieldId excludes notes
import type { VesselFieldId } from "../src/crm/catalog";
const _ok: VesselFieldId = "hull_type";
// @ts-expect-error notes is not fillable
const _bad: VesselFieldId = "notes";
void _ok; void _bad;
