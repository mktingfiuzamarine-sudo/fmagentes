import type { SupabaseClient } from "@supabase/supabase-js";

/** Reads CRM client names by id. The API never writes to the CRM. */
export interface CustomerNamePort {
  /** One query for the whole batch; ids the CRM does not know are absent from the map. */
  findNames(crmClientIds: string[]): Promise<Map<string, string>>;
}

export function createSupabaseCustomerNames(crm: SupabaseClient): CustomerNamePort {
  return {
    async findNames(crmClientIds) {
      const { data, error } = await crm.from("clients").select("id, name").in("id", crmClientIds);
      if (error) throw new Error(`CRM: ${error.message}`);
      return new Map(((data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
    },
  };
}
