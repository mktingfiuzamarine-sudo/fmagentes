import { vi } from "vitest";
import type { CrmClient, CrmPort, NewCrmClient } from "../../src/crm/CrmPort";

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
  } satisfies CrmPort;
}
