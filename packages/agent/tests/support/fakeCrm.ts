import { vi } from "vitest";
import type { PipelineId, VesselKind } from "../../src/crm/catalog";
import type {
  ClientFields,
  CrmClient,
  CrmPort,
  CrmScope,
  CrmSnapshot,
  DealFields,
  FillResult,
  NewCrmClient,
  VesselFields,
} from "../../src/crm/CrmPort";

export function createFakeCrm(seed: { byCpf?: CrmClient | null; created?: CrmClient } = {}) {
  return {
    findByPhone: vi.fn(async (_phone: string): Promise<CrmClient | null> => null),
    findById: vi.fn(async (_id: string): Promise<CrmClient | null> => null),
    findByCpf: vi.fn(async (_cpf: string): Promise<CrmClient | null> => seed.byCpf ?? null),
    create: vi.fn(
      async (input: NewCrmClient): Promise<CrmClient> =>
        seed.created ?? { id: "crm-new", name: input.name, phone: input.phone, notes: "Cadastrado pelo agente WhatsApp" },
    ),
    attachPhone: vi.fn(async (_clientId: string, _phone: string) => {}),
    loadSnapshot: vi.fn(
      async (_scope: CrmScope): Promise<CrmSnapshot> => ({ missingClientFields: [], vessels: [], openDeals: [] }),
    ),
    fillClient: vi.fn(async (_scope: CrmScope, _fields: ClientFields): Promise<FillResult> => ({ filled: [], conflicts: [] })),
    createVessel: vi.fn(async (_scope: CrmScope, _kind: VesselKind, _fields: VesselFields & { notes?: string }) => ({ id: "vessel-new" })),
    fillVessel: vi.fn(
      async (_scope: CrmScope, _vesselId: string, _fields: VesselFields, _expectedKind: VesselKind): Promise<FillResult & { kind: VesselKind }> => ({
        filled: [],
        conflicts: [],
        kind: "barco_lancha",
      }),
    ),
    findOpenDeals: vi.fn(async (_scope: CrmScope, _pipeline: PipelineId): Promise<{ id: string; title: string }[]> => []),
    createDeal: vi.fn(async (_scope: CrmScope, _pipeline: PipelineId, _title: string, _fields: DealFields) => ({ id: "deal-new" })),
    fillDeal: vi.fn(async (_scope: CrmScope, _dealId: string, _fields: DealFields): Promise<FillResult> => ({ filled: [], conflicts: [] })),
  } satisfies CrmPort;
}
